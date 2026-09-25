// SQLite lives inside a single Durable Object. Credentials, delivery attempts,
// and action receipts survive process eviction and deployment.
//
// Durable Objects bill every row SQLite visits, so the queue and receipt
// columns are real columns with indexes: each webhook and alarm touches only
// the rows it needs, however many receipts a week of deliveries leaves behind.

// One initial attempt plus five retries.
export const MAX_ATTEMPTS = 6;

// Completed deliveries and action receipts only guard against redelivery of the
// same event, so they can be dropped once Shortcut has stopped retrying it.
const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1_000;

export class DurableState {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.lastPruneAt = 0;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, credentials TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS processed (key TEXT PRIMARY KEY, at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS processed_at ON processed (at)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS deliveries (
      key TEXT PRIMARY KEY, status TEXT NOT NULL, attempts INTEGER NOT NULL,
      next_attempt_at INTEGER, completed_at INTEGER, last_error TEXT, payload TEXT
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries (status, next_attempt_at)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS deliveries_completed ON deliveries (status, completed_at)`);
    this.migrateRecords();
  }

  // Earlier versions kept everything in one records(kind, key, value) table
  // with the status inside the JSON value, which SQLite could only scan.
  migrateRecords() {
    if (!this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'records'").toArray().length) return;
    for (const { kind, key, value } of this.sql.exec("SELECT kind, key, value FROM records").toArray()) {
      const record = JSON.parse(value);
      if (kind === "workspace") this.put("workspaces", key, record);
      else if (kind === "processed") this.sql.exec("INSERT OR IGNORE INTO processed VALUES (?, ?)", key, record.at);
      else if (kind === "delivery") this.putDelivery(key, record, record.completedAt ?? null);
    }
    this.sql.exec("DROP TABLE records");
  }

  put(table, id, value) {
    this.sql.exec(`INSERT OR REPLACE INTO ${table} VALUES (?, ?)`, id, JSON.stringify(value));
  }

  putDelivery(key, { payload = null, attempts = 0, status, nextAttemptAt = null, lastError = null }, completedAt = null) {
    this.sql.exec(
      "INSERT OR REPLACE INTO deliveries VALUES (?, ?, ?, ?, ?, ?, ?)",
      key, status, attempts, nextAttemptAt, completedAt, lastError, payload === null ? null : JSON.stringify(payload),
    );
  }

  rowToDelivery({ key, status, attempts, next_attempt_at, last_error, payload }) {
    return { key, payload: payload === null ? null : JSON.parse(payload), attempts, status, nextAttemptAt: next_attempt_at, lastError: last_error };
  }

  async getWorkspace(id) {
    const rows = this.sql.exec("SELECT credentials FROM workspaces WHERE id = ?", id).toArray();
    return rows.length ? JSON.parse(rows[0].credentials) : null;
  }
  async setWorkspace(id, credentials) { this.put("workspaces", id, credentials); }
  async listWorkspaces() {
    return this.sql.exec("SELECT id, credentials FROM workspaces").toArray()
      .map(({ id, credentials }) => ({ id, slug: JSON.parse(credentials).slug, scopes: JSON.parse(credentials).scopes ?? null }));
  }
  async hasProcessed(key) { return this.sql.exec("SELECT at FROM processed WHERE key = ?", key).toArray().length > 0; }
  async markProcessed(key) { this.sql.exec("INSERT OR REPLACE INTO processed VALUES (?, ?)", key, Date.now()); }

  async getDelivery(key) {
    const rows = this.sql.exec("SELECT * FROM deliveries WHERE key = ?", key).toArray();
    return rows.length ? this.rowToDelivery(rows[0]) : null;
  }

  async enqueueDelivery(payload) {
    const key = `${payload.installation_id}:${payload.id}`;
    if (!await this.getDelivery(key)) {
      this.putDelivery(key, { payload, attempts: 0, status: "pending", nextAttemptAt: Date.now() });
    }
    // Also repair an alarm if a prior request persisted the delivery but failed
    // before scheduling it. Never acknowledge until the alarm is persisted.
    await this.schedule();
    return key;
  }

  async dueDeliveries(now = Date.now()) {
    return this.sql.exec(
      "SELECT * FROM deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 10", now,
    ).toArray().map((row) => this.rowToDelivery(row));
  }

  countByStatus(status) {
    return this.sql.exec("SELECT COUNT(*) AS n FROM deliveries WHERE status = ?", status).toArray()[0].n;
  }
  async countDeliveries() { return this.countByStatus("pending"); }
  async countFailedDeliveries() { return this.countByStatus("exhausted"); }

  // Reserve the attempt before any external API calls. An interrupted Worker
  // therefore consumes an attempt too, keeping crashes within the retry cap.
  async beginAttempt(key) {
    const delivery = await this.getDelivery(key);
    if (delivery.status !== "pending") return null;
    if (delivery.attempts >= MAX_ATTEMPTS) {
      this.putDelivery(key, { ...delivery, status: "exhausted", nextAttemptAt: null });
      return null;
    }
    delivery.attempts += 1;
    delivery.nextAttemptAt = Date.now() + 60_000;
    this.putDelivery(key, delivery);
    await this.schedule();
    return delivery;
  }

  async completeDelivery(key) {
    // Keep a receipt so redelivery cannot recreate a completed job. The action
    // records additionally handle a crash partway through a multi-action event.
    this.putDelivery(key, { status: "complete" }, Date.now());
  }

  async failDelivery(key, error) {
    const delivery = await this.getDelivery(key);
    const exhausted = delivery.attempts >= MAX_ATTEMPTS;
    this.putDelivery(key, {
      ...delivery,
      status: exhausted ? "exhausted" : "pending",
      lastError: error.message,
      nextAttemptAt: exhausted ? null : Date.now() + Math.min(60_000, 1_000 * 2 ** delivery.attempts),
    });
    return { attempts: delivery.attempts, exhausted, retriesRemaining: Math.max(0, MAX_ATTEMPTS - delivery.attempts) };
  }

  // Exhausted deliveries are kept as a diagnostic record. Runs at most hourly:
  // receipts expire by the day, and the alarm runs for every delivery.
  async prune(now = Date.now()) {
    if (now - this.lastPruneAt < PRUNE_INTERVAL_MS) return;
    this.lastPruneAt = now;
    const cutoff = now - RECEIPT_RETENTION_MS;
    this.sql.exec("DELETE FROM deliveries WHERE status = 'complete' AND completed_at < ?", cutoff);
    this.sql.exec("DELETE FROM processed WHERE at < ?", cutoff);
  }

  async schedule() {
    const { at } = this.sql.exec("SELECT MIN(next_attempt_at) AS at FROM deliveries WHERE status = 'pending'").toArray()[0];
    if (at === null) {
      await this.storage.deleteAlarm();
    } else {
      await this.storage.setAlarm(Math.max(Date.now() + 100, at));
    }
  }
}
