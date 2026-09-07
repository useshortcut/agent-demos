import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const EMPTY_STATE = {
  deliveries: {},
  processed: {},
  workspaces: {},
};

const MAX_PROCESSED_ACTIONS = 5_000;
const MAX_DELIVERY_RETRIES = 5;

function deliveryKey(payload) {
  return `${payload.installation_id ?? "unknown-installation"}:${payload.id}`;
}

export class StateStore {
  static async open(filePath) {
    let data;
    try {
      data = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      data = structuredClone(EMPTY_STATE);
    }

    const normalizedData = {
      ...structuredClone(EMPTY_STATE),
      ...data,
      deliveries: data.deliveries ?? {},
      processed: data.processed ?? {},
      workspaces: data.workspaces ?? {},
    };
    let migratedLegacyDelivery = false;

    for (const delivery of Object.values(normalizedData.deliveries)) {
      if (!delivery.exhausted && delivery.attempts > MAX_DELIVERY_RETRIES) {
        delivery.exhausted = true;
        delivery.nextAttemptAt = null;
        migratedLegacyDelivery = true;
      }
    }

    const state = new StateStore(filePath, normalizedData);
    if (migratedLegacyDelivery) await state.#persist();
    return state;
  }

  #data;
  #filePath;
  #writeChain = Promise.resolve();

  constructor(filePath, data) {
    this.#filePath = filePath;
    this.#data = data;
  }

  async #persist() {
    const serialized = `${JSON.stringify(this.#data, null, 2)}\n`;
    const temporaryPath = `${this.#filePath}.tmp`;

    this.#writeChain = this.#writeChain.then(async () => {
      await mkdir(dirname(this.#filePath), { recursive: true });
      await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.#filePath);
    });

    return this.#writeChain;
  }

  async getWorkspace(workspaceId) {
    return this.#data.workspaces[workspaceId] ?? null;
  }

  async listWorkspaces() {
    return Object.entries(this.#data.workspaces).map(([id, credentials]) => ({
      id,
      scopes: credentials.scopes ?? null,
      slug: credentials.slug,
    }));
  }

  async setWorkspace(workspaceId, credentials) {
    this.#data.workspaces[workspaceId] = credentials;
    await this.#persist();
  }

  async hasProcessed(key) {
    return Object.hasOwn(this.#data.processed, key);
  }

  async markProcessed(key) {
    this.#data.processed[key] = new Date().toISOString();
    const entries = Object.entries(this.#data.processed);
    if (entries.length > MAX_PROCESSED_ACTIONS) {
      entries
        .sort(([, left], [, right]) => left.localeCompare(right))
        .slice(0, entries.length - MAX_PROCESSED_ACTIONS)
        .forEach(([oldKey]) => delete this.#data.processed[oldKey]);
    }
    await this.#persist();
  }

  async enqueueDelivery(payload) {
    if (!payload?.id) throw new Error("Observer payload has no delivery id");

    const key = deliveryKey(payload);
    if (this.#data.deliveries[key]) return key;

    this.#data.deliveries[key] = {
      attempts: 0,
      exhausted: false,
      lastError: null,
      nextAttemptAt: 0,
      payload,
    };
    await this.#persist();
    return key;
  }

  async dueDeliveries(now = Date.now()) {
    return Object.entries(this.#data.deliveries)
      .filter(([, delivery]) => !delivery.exhausted && delivery.nextAttemptAt <= now)
      .sort(([, left], [, right]) => left.nextAttemptAt - right.nextAttemptAt)
      .map(([key, delivery]) => ({ key, ...delivery }));
  }

  async countDeliveries() {
    return Object.values(this.#data.deliveries).filter((delivery) => !delivery.exhausted).length;
  }

  async countFailedDeliveries() {
    return Object.values(this.#data.deliveries).filter((delivery) => delivery.exhausted).length;
  }

  async completeDelivery(key) {
    delete this.#data.deliveries[key];
    await this.#persist();
  }

  async failDelivery(key, error) {
    const delivery = this.#data.deliveries[key];
    if (!delivery) return;

    delivery.attempts += 1;
    delivery.lastError = error instanceof Error ? error.message : String(error);
    delivery.exhausted = delivery.attempts > MAX_DELIVERY_RETRIES;

    if (delivery.exhausted) {
      delivery.nextAttemptAt = null;
    } else {
      const retryDelayMs = Math.min(60_000, 1_000 * 2 ** Math.min(delivery.attempts, 6));
      delivery.nextAttemptAt = Date.now() + retryDelayMs;
    }

    await this.#persist();

    return {
      attempts: delivery.attempts,
      exhausted: delivery.exhausted,
      retries: MAX_DELIVERY_RETRIES,
      retriesRemaining: Math.max(0, MAX_DELIVERY_RETRIES + 1 - delivery.attempts),
    };
  }
}
