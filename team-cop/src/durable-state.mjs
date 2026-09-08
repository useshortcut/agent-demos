// SQLite lives inside a single Durable Object. Credentials, delivery attempts,
// and action receipts survive process eviction and deployment.

// One initial attempt plus five retries.
export const MAX_ATTEMPTS = 6;

// Completed deliveries and action receipts only guard against redelivery of the
// same event, so they can be dropped once Shortcut has stopped retrying it.
const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export class DurableState {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS records (
      kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY (kind, key)
    )`);
  }

  get(kind, key) {
    const rows = this.sql.exec("SELECT value FROM records WHERE kind = ? AND key = ?", kind, key).toArray();
    return rows.length ? JSON.parse(rows[0].value) : null;
  }

  put(kind, key, value) {
    this.sql.exec("INSERT OR REPLACE INTO records VALUES (?, ?, ?)", kind, key, JSON.stringify(value));
  }

  entries(kind) {
    return this.sql.exec("SELECT key, value FROM records WHERE kind = ?", kind)
      .toArray().map(({ key, value }) => ({ key, ...JSON.parse(value) }));
  }

  deliveries(status) {
    return this.sql.exec(
      "SELECT key, value FROM records WHERE kind = 'delivery' AND json_extract(value, '$.status') = ?", status,
    ).toArray().map(({ key, value }) => ({ key, ...JSON.parse(value) }));
  }

  async getWorkspace(id) { return this.get("workspace", id); }
  async setWorkspace(id, credentials) { this.put("workspace", id, credentials); }
  async listWorkspaces() {
    return this.entries("workspace").map(({ key, slug, scopes }) => ({ id: key, slug, scopes: scopes ?? null }));
  }
  async hasProcessed(key) { return this.get("processed", key) !== null; }
  async markProcessed(key) { this.put("processed", key, { at: Date.now() }); }

  async enqueueDelivery(payload) {
    const key = `${payload.installation_id}:${payload.id}`;
    if (!this.get("delivery", key)) {
      this.put("delivery", key, { payload, attempts: 0, status: "pending", nextAttemptAt: Date.now() });
    }
    // Also repair an alarm if a prior request persisted the delivery but failed
    // before scheduling it. Never acknowledge until the alarm is persisted.
    await this.schedule();
    return key;
  }

  async dueDeliveries(now = Date.now()) {
    return this.deliveries("pending")
      .filter((item) => item.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
  }

  async countDeliveries() { return this.deliveries("pending").length; }
  async countFailedDeliveries() { return this.deliveries("exhausted").length; }

  // Reserve the attempt before any external API calls. An interrupted Worker
  // therefore consumes an attempt too, keeping crashes within the retry cap.
  async beginAttempt(key) {
    const delivery = this.get("delivery", key);
    if (delivery.status !== "pending") return null;
    if (delivery.attempts >= MAX_ATTEMPTS) {
      this.put("delivery", key, { ...delivery, status: "exhausted", nextAttemptAt: null });
      return null;
    }
    delivery.attempts += 1;
    delivery.nextAttemptAt = Date.now() + 60_000;
    this.put("delivery", key, delivery);
    await this.schedule();
    return delivery;
  }

  async completeDelivery(key) {
    // Keep a receipt so redelivery cannot recreate a completed job. The action
    // records additionally handle a crash partway through a multi-action event.
    this.put("delivery", key, { status: "complete", completedAt: Date.now() });
  }

  async failDelivery(key, error) {
    const delivery = this.get("delivery", key);
    const exhausted = delivery.attempts >= MAX_ATTEMPTS;
    this.put("delivery", key, {
      ...delivery,
      status: exhausted ? "exhausted" : "pending",
      lastError: error.message,
      nextAttemptAt: exhausted ? null : Date.now() + Math.min(60_000, 1_000 * 2 ** delivery.attempts),
    });
    return { attempts: delivery.attempts, exhausted, retriesRemaining: Math.max(0, MAX_ATTEMPTS - delivery.attempts) };
  }

  // Exhausted deliveries are kept as a diagnostic record.
  async prune(now = Date.now()) {
    const cutoff = now - RECEIPT_RETENTION_MS;
    this.sql.exec(
      "DELETE FROM records WHERE kind = 'delivery' AND json_extract(value, '$.status') = 'complete' AND json_extract(value, '$.completedAt') < ?",
      cutoff,
    );
    this.sql.exec("DELETE FROM records WHERE kind = 'processed' AND json_extract(value, '$.at') < ?", cutoff);
  }

  async schedule() {
    const pending = this.deliveries("pending");
    if (pending.length) {
      await this.storage.setAlarm(Math.max(Date.now() + 100, Math.min(...pending.map((item) => item.nextAttemptAt))));
    } else {
      await this.storage.deleteAlarm();
    }
  }
}
