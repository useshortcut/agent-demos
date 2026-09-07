import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import {
  buildReminder,
  createTeamCopProcessor,
  reminderReason,
  verifyWebhookSignature,
} from "../src/team-cop.mjs";

const workspaceId = "workspace-1";
const credentials = {
  accessToken: "access-token",
  expiresAt: "2099-01-01T00:00:00Z",
  memberId: "team-cop-member",
  refreshToken: "refresh-token",
  slug: "acme",
};

function observerPayload(action, actor = { member_id: "member-1", displayable_name: "Kurt Schrader" }) {
  return {
    id: "delivery-1",
    version: "v2",
    installation_id: "installation-1",
    workspace2: { id: workspaceId, url_slug: "acme" },
    actor,
    actions: [action],
  };
}

function harness({ story = { id: 123, team: null }, member = { mention_name: "kurt" } } = {}) {
  const processed = new Set();
  const calls = [];
  const logs = [];
  const state = {
    async getWorkspace(id) {
      assert.equal(id, workspaceId);
      return credentials;
    },
    async hasProcessed(key) {
      return processed.has(key);
    },
    async markProcessed(key) {
      processed.add(key);
    },
  };
  const client = {
    async getStory(id, creds, storyId) {
      calls.push(["getStory", id, creds, storyId]);
      return story;
    },
    async getMember(id, creds, memberId) {
      calls.push(["getMember", id, creds, memberId]);
      return member;
    },
    async postStoryComment(id, creds, storyId, comment) {
      calls.push(["postStoryComment", id, creds, storyId, comment]);
    },
  };
  const logger = {
    info(message, details) {
      logs.push(["info", message, details]);
    },
    warn(message, details) {
      logs.push(["warn", message, details]);
    },
    error(message, details) {
      logs.push(["error", message, details]);
    },
  };

  return {
    client,
    state,
    calls,
    logs,
    processed,
    process: createTeamCopProcessor({ client, logger, state }),
  };
}

describe("reminderReason", () => {
  it("selects Story creation", () => {
    assert.equal(reminderReason({ action: "create", entity_type: "story" }), "created");
  });

  it("selects a Story transition to started", () => {
    assert.equal(
      reminderReason({
        action: "update",
        entity_type: "story",
        changes: [{ attribute: "started", adds: [true], removes: [false] }],
      }),
      "started",
    );
  });

  it("ignores unrelated, stopped, and non-Story actions", () => {
    assert.equal(
      reminderReason({
        action: "update",
        entity_type: "story",
        changes: [{ attribute: "estimate", adds: [3], removes: [2] }],
      }),
      null,
    );
    assert.equal(
      reminderReason({
        action: "update",
        entity_type: "story",
        changes: [{ attribute: "started", adds: [false], removes: [true] }],
      }),
      null,
    );
    assert.equal(reminderReason({ action: "create", entity_type: "epic" }), null);
  });
});

describe("buildReminder", () => {
  it("builds the requested mention and message", () => {
    assert.equal(
      buildReminder("@kurt"),
      "@kurt Stories need to be in a Team! Please add one!",
    );
  });
});

describe("Team Cop processor", () => {
  it("does not suppress the same Story ID in another workspace", async () => {
    const h = harness();
    h.state.getWorkspace = async () => credentials;
    await h.process(observerPayload({ action: "create", entity_type: "story", id: 123 }));
    await h.process({ ...observerPayload({ action: "create", entity_type: "story", id: 123 }),
      id: "other-delivery", workspace2: { id: "workspace-2", url_slug: "other" } });
    const posts = h.calls.filter(([name]) => name === "postStoryComment");
    assert.equal(posts.length, 2);
    assert.notEqual(posts[0][4].external_id, posts[1][4].external_id);
  });

  it("does not record a Story reminder when posting fails", async () => {
    const h = harness();
    const post = h.client.postStoryComment;
    h.client.postStoryComment = async () => { throw new Error("Temporary failure"); };
    await assert.rejects(h.process(observerPayload({ action: "create", entity_type: "story", id: 123 })), /Temporary failure/);
    h.client.postStoryComment = post;
    await h.process({ ...observerPayload({ action: "update", entity_type: "story", id: 123,
      changes: [{ attribute: "started", adds: [true], removes: [false] }] }), id: "new-delivery" });
    assert.equal(h.calls.filter(([name]) => name === "postStoryComment").length, 1);
  });

  it("uses a stable Story reminder ID across deliveries, actors and installations", async () => {
    const first = harness();
    const second = harness();
    await first.process(observerPayload({ action: "create", entity_type: "story", id: 123 }));
    await second.process({ ...observerPayload({ action: "update", entity_type: "story", id: 123,
      changes: [{ attribute: "started", adds: [true], removes: [false] }] },
    { member_id: "another-member" }), id: "different-delivery", installation_id: "new-installation" });
    assert.equal(first.calls.find(([name]) => name === "postStoryComment")[4].external_id,
      second.calls.find(([name]) => name === "postStoryComment")[4].external_id);
  });

  it("does not count a Team-present skip as having sent a reminder", async () => {
    const story = { id: 123, team: { id: "team" } };
    const { calls, process } = harness({ story });
    await process(observerPayload({ action: "create", entity_type: "story", id: 123 }));
    story.team = null;
    await process({ ...observerPayload({ action: "update", entity_type: "story", id: 123,
      changes: [{ attribute: "started", adds: [true], removes: [false] }] }), id: "delivery-2" });
    assert.equal(calls.filter(([name]) => name === "postStoryComment").length, 1);
  });

  it("comments to the creator when a Story is created without a Team", async () => {
    const { calls, process } = harness();

    await process(observerPayload({ action: "create", entity_type: "story", id: 123 }));

    assert.deepEqual(calls.map(([name]) => name), ["getStory", "getMember", "postStoryComment"]);
    const comment = calls[2][4];
    assert.equal(comment.text, "@kurt Stories need to be in a Team! Please add one!");
    assert.match(comment.external_id, /^team-cop:[a-f0-9]{32}$/);
  });

  it("comments to the starter on a started transition without a Team", async () => {
    const { calls, process } = harness({ member: { mention_name: "starter-person" } });
    const action = {
      action: "update",
      entity_type: "story",
      id: 123,
      changes: [{ attribute: "started", adds: [true], removes: [false] }],
    };

    await process(observerPayload(action));

    assert.equal(
      calls[2][4].text,
      "@starter-person Stories need to be in a Team! Please add one!",
    );
  });

  it("does not comment when the Story already has a Team", async () => {
    const { calls, logs, process } = harness({
      story: { id: 123, team: { id: "team-1", name: "Platform" } },
    });

    await process(observerPayload({ action: "create", entity_type: "story", id: 123 }));

    assert.deepEqual(calls.map(([name]) => name), ["getStory"]);
    assert.deepEqual(logs, [
      [
        "info",
        "Story event has a Team; no reminder needed",
        {
          actor: {
            displayableName: "Kurt Schrader",
            memberId: "member-1",
          },
          deliveryId: "delivery-1",
          reason: "created",
          storyId: 123,
          teamId: "team-1",
          teamName: "Platform",
          workspaceId,
        },
      ],
    ]);
  });

  it("does not react to its own actions", async () => {
    const { calls, process } = harness();

    await process(
      observerPayload(
        { action: "create", entity_type: "story", id: 123 },
        { member_id: credentials.memberId, displayable_name: "Team Cop" },
      ),
    );

    assert.deepEqual(calls, []);
  });

  it("does not repeat an already processed action", async () => {
    const { calls, process } = harness();
    const payload = observerPayload({ action: "create", entity_type: "story", id: 123 });

    await process(payload);
    await process(payload);

    assert.equal(calls.filter(([name]) => name === "postStoryComment").length, 1);
  });
});

describe("verifyWebhookSignature", () => {
  it("accepts the raw body signed with the configured secret", () => {
    const rawBody = Buffer.from('{"hello":"world"}');
    const signature = createHmac("sha256", "secret").update(rawBody).digest("hex");

    assert.equal(verifyWebhookSignature(rawBody, signature, "secret"), true);
    assert.equal(verifyWebhookSignature(rawBody, "00", "secret"), false);
  });
});
