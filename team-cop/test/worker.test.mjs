import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import worker, { TeamCop } from "../src/worker.mjs";
import { DurableState } from "../src/durable-state.mjs";

function storageFixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  return {
    alarmAt: null,
    sql: { exec(query, ...args) { return { toArray: () => db.prepare(query).all(...args) }; } },
    async setAlarm(at) { this.alarmAt = at; },
    async deleteAlarm() { this.alarmAt = null; },
  };
}

// Cloudflare's SQL exec runs immediately; node:sqlite runs on all().
function eagerStorage(t) {
  const storage = storageFixture(t);
  const exec = storage.sql.exec;
  storage.sql.exec = (query, ...args) => {
    const rows = exec(query, ...args).toArray();
    return { toArray: () => rows };
  };
  return storage;
}

const payload = {
  id: "delivery", installation_id: "install", workspace2: { id: "workspace" },
  actor: { member_id: "creator", displayable_name: "Ada" },
  actions: [{ id: 123, action: "create", entity_type: "story" }],
};
const env = {
  CLIENT_ID: "client", CLIENT_SECRET: "secret", WEBHOOK_SECRET: "signing",
  REDIRECT_URI: "https://team-cop.example/oauth/callback",
};

it("verifies signed webhooks before forwarding, and accepts validation without queueing", async () => {
  const forwarded = [];
  const bindings = { ...env, TEAM_COP: {
    idFromName: (name) => name,
    get: () => ({ async fetch(req) { forwarded.push(await req.json()); return Response.json({}, { status: 202 }); } }),
  } };
  const request = (body, valid = true) => new Request("https://worker/webhook", {
    method: "POST", body,
    headers: { "Payload-Signature": valid ? createHmac("sha256", "signing").update(body).digest("hex") : "bad" },
  });
  assert.equal((await worker.fetch(request(JSON.stringify(payload), false), bindings)).status, 401);
  assert.equal((await worker.fetch(request('{"type":"validation"}'), bindings)).status, 200);
  assert.deepEqual(forwarded, []);
  assert.equal((await worker.fetch(request(JSON.stringify(payload)), bindings)).status, 202);
  assert.deepEqual(forwarded, [payload]);
  assert.equal((await worker.fetch(request("{}"), {})).status, 503);
});

it("persists five retries, stops after six attempts, and does not rearm on redelivery", async (t) => {
  const storage = eagerStorage(t);
  let state = new DurableState(storage);
  const key = await state.enqueueDelivery(payload);
  for (let i = 1; i <= 6; i++) {
    assert.equal((await state.beginAttempt(key)).attempts, i);
    const result = await state.failDelivery(key, new Error("No credentials"));
    assert.equal(result.exhausted, i === 6);
    // Reconstruct with the same database, as if the Worker were evicted.
    state = new DurableState(storage);
  }
  await state.enqueueDelivery(payload);
  assert.equal(await state.countFailedDeliveries(), 1);
  assert.equal(await state.countDeliveries(), 0);
  assert.equal(storage.alarmAt, null);
});

it("an interrupted final attempt is exhausted without making a seventh call", async (t) => {
  const storage = eagerStorage(t);
  const state = new DurableState(storage);
  const key = await state.enqueueDelivery(payload);
  for (let i = 0; i < 6; i++) await state.beginAttempt(key);
  const reopened = new DurableState(storage);
  assert.equal(await reopened.beginAttempt(key), null);
  await reopened.schedule();
  assert.equal(storage.alarmAt, null);
});

it("OAuth credentials and action receipts survive restart, and alarms post only one reminder", async (t) => {
  const storage = eagerStorage(t);
  const ctx = { storage };
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push([url, options]);
    if (url.endsWith("/token")) return Response.json({
      access_token: "token", refresh_token: "refresh", permission_id: "cop",
      workspace2_id: "workspace", workspace2_slug: "acme", scope: "read comment-write",
    });
    if (url.includes("/members/")) return Response.json({ mention_name: "ada" });
    if (url.includes("/comments?") && options.method !== "POST") {
      return Response.json({ entities: [], total_pages: 1 });
    }
    if (options.method === "POST") return Response.json({ id: 1 });
    return Response.json({ team: null });
  });
  let object = new TeamCop(ctx, env);
  assert.equal((await object.fetch(new Request("https://worker/oauth/callback?code=test"))).status, 200);
  assert.deepEqual((await object.state.listWorkspaces())[0].scopes, ["read", "comment-write"]);
  await object.fetch(new Request("https://internal/enqueue", { method: "POST", body: JSON.stringify(payload) }));
  object = new TeamCop(ctx, env);
  await object.alarm();
  const posts = calls.filter(([url, options]) => url.includes("/comments?") && options.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0][1].body).text, "@ada Stories need to be in a Team! Please add one!");
  await object.state.enqueueDelivery(payload);
  await object.alarm();
  assert.equal(calls.filter(([url, options]) => url.includes("/comments?") && options.method === "POST").length, 1);
  assert.equal(storage.alarmAt, null);
});

it("finds a previously posted reminder on later pages after interrupted processing", async (t) => {
  const storage = eagerStorage(t);
  const pages = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.notEqual(options.method, "POST");
    pages.push(url);
    assert.equal(new URL(url).searchParams.has("page"), false);
    return Response.json({ current_page: pages.length, total_pages: 2,
      ...(pages.length === 1 ? { next_page_url: "https://api.app.shortcut.com/api/v4/acme/stories/123/comments?cursor=page-two&fields=id,author,deleted" } : {}),
      entities: pages.length === 1 ? [] : [
      { id: 5, author: { id: "cop" } },
    ] });
  });
  const object = new TeamCop({ storage }, env);
  await object.state.setWorkspace("workspace", { accessToken: "token", slug: "acme", memberId: "cop" });
  const result = await object.client.postStoryComment("workspace", await object.state.getWorkspace("workspace"), 123,
    { text: "test" });
  assert.equal(result.id, 5);
  assert.equal(pages.length, 2);
});

it("prunes stale completion and action receipts but keeps exhausted deliveries", async (t) => {
  const state = new DurableState(eagerStorage(t));
  const done = await state.enqueueDelivery(payload);
  await state.beginAttempt(done);
  await state.completeDelivery(done);
  await state.markProcessed("install:delivery:story:123:created");
  const failed = await state.enqueueDelivery({ ...payload, id: "failed" });
  for (let i = 0; i < 6; i++) { await state.beginAttempt(failed); await state.failDelivery(failed, new Error("nope")); }
  await state.prune(Date.now() + 8 * 24 * 60 * 60 * 1_000);
  assert.equal(await state.hasProcessed("install:delivery:story:123:created"), false);
  assert.equal(state.get("delivery", done), null);
  assert.equal(await state.countFailedDeliveries(), 1);
  // A redelivery after pruning is a fresh job rather than a silently ignored one.
  await state.enqueueDelivery(payload);
  assert.equal(await state.countDeliveries(), 1);
});
