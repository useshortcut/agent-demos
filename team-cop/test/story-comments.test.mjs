import assert from "node:assert/strict";
import { it } from "node:test";
import { createTeamCopProcessor } from "../src/team-cop.mjs";
import { ShortcutClient } from "../src/shortcut-client.mjs";

it("uses live Story comments across new deliveries, actors, and processor restarts", async () => {
  const comments = [];
  const logs = [];
  let listRequests = 0;
  let posts = 0;
  const credentials = { accessToken: "test-token", memberId: "cop", slug: "acme" };
  const logger = { info(...args) { logs.push(args); } };
  // Each restart has no local receipts: actual comments must still suppress duplicates.
  const restart = () => {
    const processed = new Set();
    const state = { async getWorkspace() { return credentials; },
      async hasProcessed(key) { return processed.has(key); },
      async markProcessed(key) { processed.add(key); } };
    const client = new ShortcutClient({ apiBase: "https://api.example.com", clientId: "test-client", clientSecret: "test-secret",
      redirectUri: "https://agent.example/callback", state, logger, checkExistingComments: true,
      async fetchImpl(url, options) {
        if (url.includes("/comments?")) {
          if (options.method === "POST") {
            const saved = { id: ++posts, author: { id: "cop" }, ...JSON.parse(options.body) };
            comments.push(saved);
            return Response.json({ entity: saved });
          }
          listRequests += 1;
          return Response.json({ current_page: 1, total_pages: comments.length ? 1 : 0, entities: comments });
        }
        if (url.includes("/members/")) return Response.json({ entity: { mention_name: "person" } });
        return Response.json({ entity: { team: null } });
      } });
    return createTeamCopProcessor({ client, state, logger });
  };
  const event = (id, action = "update") => ({ id, installation_id: "install", workspace2: { id: "workspace" },
    actor: { member_id: id, displayable_name: id },
    actions: [{ id: 123, entity_type: "story", action,
      changes: [{ attribute: "started", adds: [true], removes: [false] }] }] });
  let process = restart();
  await process(event("creator", "create"));
  await process(event("starter"));
  process = restart();
  await process(event("another-starter"));
  assert.equal(posts, 1);
  assert.equal(listRequests, 3, "Every new qualifying event reads current comments");
  assert.equal(logs.filter(([message]) => message === "Posted Team reminder").length, 1);
  assert.equal(logs.filter(([message]) => /already.*comment/i.test(message)).length, 2);

  // Comment history, not a permanent Story flag, is authoritative.
  comments.length = 0;
  await process(event("after-comment-removal"));
  assert.equal(posts, 2);
  assert.equal(listRequests, 4);
});
