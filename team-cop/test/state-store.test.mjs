import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { StateStore } from "../src/state-store.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function openStore() {
  const directory = await mkdtemp(join(tmpdir(), "team-cop-state-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "state.json");
  return { filePath, state: await StateStore.open(filePath) };
}

describe("StateStore", () => {
  it("persists OAuth credentials and processed action keys", async () => {
    const { filePath, state } = await openStore();
    await state.setWorkspace("workspace-1", {
      accessToken: "secret",
      scopes: ["read", "comment-write"],
      slug: "acme",
    });
    await state.markProcessed("delivery:story:123:created");

    const reopened = await StateStore.open(filePath);

    assert.deepEqual(await reopened.getWorkspace("workspace-1"), {
      accessToken: "secret",
      scopes: ["read", "comment-write"],
      slug: "acme",
    });
    assert.deepEqual(await reopened.listWorkspaces(), [
      { id: "workspace-1", scopes: ["read", "comment-write"], slug: "acme" },
    ]);
    assert.equal(await reopened.hasProcessed("delivery:story:123:created"), true);
  });

  it("persists and retries queued deliveries", async () => {
    const { filePath, state } = await openStore();
    const payload = {
      id: "delivery-1",
      installation_id: "installation-1",
      actions: [],
    };
    const key = await state.enqueueDelivery(payload);

    assert.equal((await state.dueDeliveries()).length, 1);
    await state.failDelivery(key, new Error("temporary failure"));
    assert.equal((await state.dueDeliveries()).length, 0);
    assert.equal((await state.dueDeliveries(Date.now() + 120_000)).length, 1);

    const reopened = await StateStore.open(filePath);
    assert.equal(await reopened.countDeliveries(), 1);
    await reopened.completeDelivery(key);
    assert.equal(await reopened.countDeliveries(), 0);
    const persisted = await readFile(filePath, "utf8");
    assert.doesNotThrow(() => JSON.parse(persisted));
  });

  it("stops scheduling a delivery after five retries", async () => {
    const { filePath, state } = await openStore();
    const key = await state.enqueueDelivery({
      id: "delivery-that-keeps-failing",
      installation_id: "installation-1",
      actions: [],
    });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const failure = await state.failDelivery(key, new Error(`failure ${attempt}`));
      assert.equal(failure.exhausted, false);
      assert.equal((await state.dueDeliveries(Number.MAX_SAFE_INTEGER)).length, 1);
    }

    const finalFailure = await state.failDelivery(key, new Error("failure 6"));

    assert.deepEqual(finalFailure, {
      attempts: 6,
      exhausted: true,
      retries: 5,
      retriesRemaining: 0,
    });
    assert.equal((await state.dueDeliveries(Number.MAX_SAFE_INTEGER)).length, 0);
    assert.equal(await state.countDeliveries(), 0);
    assert.equal(await state.countFailedDeliveries(), 1);

    const reopened = await StateStore.open(filePath);
    assert.equal((await reopened.dueDeliveries(Number.MAX_SAFE_INTEGER)).length, 0);
    assert.equal(await reopened.countFailedDeliveries(), 1);
  });

  it("immediately exhausts legacy queued deliveries already over the retry cap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "team-cop-state-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "state.json");
    await writeFile(
      filePath,
      `${JSON.stringify({
        deliveries: {
          "installation-1:old-delivery": {
            attempts: 17,
            lastError: "old failure",
            nextAttemptAt: 0,
            payload: { id: "old-delivery", installation_id: "installation-1", actions: [] },
          },
        },
        processed: {},
        workspaces: {},
      })}\n`,
    );

    const state = await StateStore.open(filePath);

    assert.equal((await state.dueDeliveries(Number.MAX_SAFE_INTEGER)).length, 0);
    assert.equal(await state.countDeliveries(), 0);
    assert.equal(await state.countFailedDeliveries(), 1);
    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(persisted.deliveries["installation-1:old-delivery"].exhausted, true);
    assert.equal(persisted.deliveries["installation-1:old-delivery"].nextAttemptAt, null);
  });
});
