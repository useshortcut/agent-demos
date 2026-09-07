// SQLite lives inside a single Durable Object. Credentials, delivery attempts,
// and action receipts survive process eviction and deployment.
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
    return this.entries("delivery")
      .filter((item) => item.status === "pending" && item.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
  }

  async countDeliveries() {
    return this.entries("delivery").filter((item) => item.status === "pending").length;
  }
  async countFailedDeliveries() {
    return this.entries("delivery").filter((item) => item.status === "exhausted").length;
  }

  // Reserve the attempt before any external API calls. An interrupted Worker
  // therefore consumes an attempt too, keeping crashes within the retry cap.
  async beginAttempt(key) {
    const delivery = this.get("delivery", key);
    if (delivery.status !== "pending") return null;
    if (delivery.attempts >= 6) {
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
    const exhausted = delivery.attempts >= 6;
    this.put("delivery", key, {
      ...delivery,
      status: exhausted ? "exhausted" : "pending",
      lastError: error.message,
      nextAttemptAt: exhausted ? null : Date.now() + Math.min(60_000, 1_000 * 2 ** delivery.attempts),
    });
    return { attempts: delivery.attempts, exhausted, retriesRemaining: Math.max(0, 6 - delivery.attempts) };
  }

  async schedule() {
    const pending = this.entries("delivery").filter((item) => item.status === "pending");
    if (pending.length) {
      await this.storage.setAlarm(Math.max(Date.now() + 100, Math.min(...pending.map((item) => item.nextAttemptAt))));
    } else {
      await this.storage.deleteAlarm();
    }
  }
}
