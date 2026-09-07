import assert from "node:assert/strict";
import { it } from "node:test";
import { ShortcutClient } from "../src/shortcut-client.mjs";

const base = "https://api.example.com";
const path = "/api/v4/acme/stories/123/comments";
const credentials = { accessToken: "secret-access", refreshToken: "secret-refresh", memberId: "cop", slug: "acme" };
const comment = { text: "private reminder text", external_id: "reminder" };
const existing = { id: 5, external_id: "reminder", author: { id: "cop" } };
function client(fetchImpl, logger = {}) {
  return new ShortcutClient({ apiBase: base, clientId: "client", clientSecret: "secret-client", redirectUri: "https://agent.example/callback",
    state: { async setWorkspace() {} }, checkExistingComments: true, fetchImpl, logger });
}

for (const match of [true, false]) {
  it(`uses cursor pagination and ${match ? "finds an existing reminder" : "posts only after the final page"}`, async () => {
    const calls = [];
    const next = `${base}${path}?cursor=opaque%2Bcursor%3D&fields=id,external_id,author`;
    const c = client(async (url, options) => {
      calls.push([url, options]);
      const parsed = new URL(url);
      if (options.method === "POST") return Response.json({ entity: { id: 6 } });
      // Mirror v4's allowed query parameters, including cursor exclusivity.
      if (parsed.searchParams.has("page")) return Response.json({ message: "page is not allowed" }, { status: 400 });
      if (parsed.searchParams.has("cursor")) {
        assert.equal(url, next);
        assert.equal(parsed.searchParams.has("limit"), false);
        return Response.json({ current_page: 2, total_pages: 2, entities: match ? [existing] : [] });
      }
      assert.equal(parsed.searchParams.get("limit"), "100");
      assert.equal(parsed.searchParams.get("fields"), "id,external_id,author");
      return Response.json({ current_page: 1, total_pages: 2, entities: [], next_page_url: next });
    });
    assert.equal((await c.postStoryComment("workspace", credentials, 123, comment)).id, match ? 5 : 6);
    assert.equal(calls.length, match ? 2 : 3);
    assert.equal(calls.filter(([, opts]) => opts.method === "POST").length, match ? 0 : 1);
  });
}

for (const next of ["https://evil.example/steal?cursor=x", `${base}/api/v4/other/stories/123/comments?cursor=x`, `${base}${path}?cursor=loop`]) {
  it(`fails closed on unsafe or repeated next-page URLs: ${next}`, async () => {
    let calls = 0;
    const c = client(async (url, options) => {
      assert.notEqual(options.method, "POST");
      assert.ok(url.startsWith(`${base}${path}?`));
      assert.ok(++calls <= 2, "pagination must not loop");
      return Response.json({ current_page: 1, total_pages: 3, entities: [], next_page_url: next });
    });
    await assert.rejects(c.postStoryComment("workspace", credentials, 123, comment), /pagination|next.page|cursor/i);
    assert.equal(calls, next.includes("loop") ? 2 : 1);
  });
}

it("does not post when a multi-page response omits its next-page URL", async () => {
  const c = client(async (url, options) => {
    assert.notEqual(options.method, "POST");
    return Response.json({ current_page: 1, total_pages: 2, entities: [] });
  });
  await assert.rejects(c.postStoryComment("workspace", credentials, 123, comment), /pagination|next.page|cursor/i);
});

it("logs API method, path and safe error details without credentials or comment text", async () => {
  const logs = [];
  const c = client(async (url, options) => options.method === "POST"
    ? Response.json({ tag: "invalid_params", message: "Rejected secret-access secret-refresh secret-client private reminder text", text: comment.text, access_token: credentials.accessToken }, { status: 400 })
    : Response.json({ current_page: 1, total_pages: 1, entities: [] }),
  { error(message, details) { logs.push([message, details]); } });
  await assert.rejects(c.postStoryComment("workspace", credentials, 123, comment), /HTTP 400/);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], "Shortcut API request rejected");
  assert.equal(logs[0][1].method, "POST");
  assert.equal(logs[0][1].path, path);
  assert.equal(logs[0][1].status, 400);
  assert.match(JSON.stringify(logs), /invalid_params/);
  assert.match(JSON.stringify(logs), /Rejected/);
  assert.doesNotMatch(JSON.stringify(logs), /secret-access|secret-refresh|secret-client|private reminder text|Bearer/);
});

it("does not disclose pagination cursors in API error logs", async () => {
  const logs = [];
  const c = client(async (url) => new URL(url).searchParams.has("cursor")
    ? Response.json({ tag: "invalid_cursor", message: "Invalid secret-cursor-value" }, { status: 400 })
    : Response.json({ current_page: 1, total_pages: 2, entities: [], next_page_url: `${base}${path}?cursor=secret-cursor-value` }),
  { error(message, details) { logs.push([message, details]); } });
  await assert.rejects(c.postStoryComment("workspace", credentials, 123, comment), /HTTP 400/);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][1].method, "GET");
  assert.equal(logs[0][1].path, path);
  assert.match(JSON.stringify(logs), /invalid_cursor/);
  assert.doesNotMatch(JSON.stringify(logs), /secret-cursor-value/);
});

it("posts on an empty list and does not mistake another author's comment for its own", async () => {
  for (const entities of [[], [{ ...existing, author: { id: "someone-else" } }]]) {
    let posts = 0;
    const c = client(async (url, options) => {
      if (options.method === "POST") {
        posts += 1;
        return Response.json({ entity: { id: 6 } });
      }
      return Response.json({ current_page: 1, total_pages: entities.length ? 1 : 0, entities });
    });
    assert.equal((await c.postStoryComment("workspace", credentials, 123, comment)).id, 6);
    assert.equal(posts, 1);
  }
});

it("bounds error details and omits arbitrary response fields", async () => {
  const logs = [];
  const c = client(async () => Response.json({
    message: `Invalid\nrequest ${"x".repeat(2000)}`,
    tag: "invalid_params",
    entity: { text: "unrelated private text" },
    headers: { authorization: "Bearer unknown-secret" },
  }, { status: 400 }), { error(...args) { logs.push(args); } });
  await assert.rejects(c.getStory("workspace", credentials, 123), /HTTP 400/);
  assert.equal(logs.length, 1);
  assert.ok(logs[0][1].message.length <= 500);
  assert.doesNotMatch(logs[0][1].message, /[\r\n]/);
  assert.doesNotMatch(JSON.stringify(logs), /unrelated private text|unknown-secret|authorization/);
});

it("logs status and endpoint but not a non-JSON API error body", async () => {
  const logs = [];
  const c = client(async () => new Response("<html>private proxy error</html>", { status: 502 }),
    { error(...args) { logs.push(args); } });
  await assert.rejects(c.getStory("workspace", credentials, 123), /HTTP 502/);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][1].status, 502);
  assert.equal(logs[0][1].path, "/api/v4/acme/stories/123");
  assert.doesNotMatch(JSON.stringify(logs), /private proxy error/);
});
