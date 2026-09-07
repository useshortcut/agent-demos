import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ShortcutClient } from "../src/shortcut-client.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ShortcutClient", () => {
  for (const operation of ["authorization code exchange", "token refresh", "authorized API request"]) {
    it(`preserves the global fetch receiver during ${operation}`, async (t) => {
      const calls = [];
      t.mock.method(globalThis, "fetch", async function (url, options) {
        // Workers' native fetch rejects calls with a different receiver; Node's does not.
        if (this !== globalThis) {
          throw new TypeError("Illegal invocation: function called with incorrect `this` reference");
        }
        calls.push([url, options]);
        if (url.endsWith("/token")) {
          return jsonResponse({
            access_token: "new-access-token",
            access_token_expires_at: "2099-01-01T00:00:00Z",
            refresh_token: "new-refresh-token",
            permission_id: "agent-member",
            scope: "read comment-write",
            workspace2_id: "workspace-1",
            workspace2_slug: "acme",
          });
        }
        return jsonResponse({ entity: { id: 123 } });
      });
      const client = new ShortcutClient({
        apiBase: "https://api.example.com",
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "https://agent.example.com/oauth/callback",
        logger: {},
        state: { async setWorkspace() {} },
        // Deliberately omit fetchImpl to exercise the production default.
      });
      const credentials = {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        slug: "acme",
        expiresAt: operation === "token refresh" ? "2000-01-01T00:00:00Z" : "2099-01-01T00:00:00Z",
      };

      if (operation === "authorization code exchange") {
        const result = await client.exchangeAuthorizationCode("authorization-code");
        assert.equal(result.workspaceId, "workspace-1");
        assert.equal(calls[0][1].body.get("grant_type"), "authorization_code");
      } else {
        assert.deepEqual(await client.getStory("workspace-1", credentials, 123), { id: 123 });
        if (operation === "token refresh") {
          assert.equal(calls[0][1].body.get("grant_type"), "refresh_token");
          assert.equal(calls[1][1].headers.authorization, "Bearer new-access-token");
        }
      }
      assert.equal(calls.length, operation === "token refresh" ? 2 : 1);
    });
  }

  it("logs safe OAuth diagnostics when the token endpoint rejects the client", async () => {
    const logs = [];
    const client = new ShortcutClient({
      apiBase: "https://api.app.shortcut-staging.com",
      clientId: "client-id-that-must-not-be-logged",
      clientSecret: "client-secret-that-must-not-be-logged",
      redirectUri: "https://agent.example.com/oauth/callback",
      state: { async setWorkspace() {} },
      logger: {
        info(message, details) {
          logs.push(["info", message, details]);
        },
        error(message, details) {
          logs.push(["error", message, details]);
        },
      },
      async fetchImpl() {
        return jsonResponse({ error: "invalid_client" }, 400);
      },
    });

    await assert.rejects(() => client.exchangeAuthorizationCode("authorization-code-secret"), {
      message: "Shortcut token request failed with HTTP 400",
    });

    assert.equal(logs.length, 2);
    assert.deepEqual(logs[0].slice(0, 2), ["info", "Shortcut OAuth token request"]);
    assert.equal(logs[0][2].apiBase, "https://api.app.shortcut-staging.com");
    assert.equal(logs[0][2].grantType, "authorization_code");
    assert.equal(logs[0][2].redirectUri, "https://agent.example.com/oauth/callback");
    assert.match(logs[0][2].clientIdFingerprint, /^[a-f0-9]{12}$/);
    assert.deepEqual(logs[1].slice(0, 2), ["error", "Shortcut OAuth token request rejected"]);
    assert.equal(logs[1][2].error, "invalid_client");
    assert.equal(logs[1][2].status, 400);
    assert.match(logs[1][2].hint, /credentials.*API environment/i);

    const renderedLogs = JSON.stringify(logs);
    assert.doesNotMatch(renderedLogs, /client-id-that-must-not-be-logged/);
    assert.doesNotMatch(renderedLogs, /client-secret-that-must-not-be-logged/);
    assert.doesNotMatch(renderedLogs, /authorization-code-secret/);
  });

  it("exchanges an authorization code and stores workspace credentials", async () => {
    const calls = [];
    const stored = [];
    const client = new ShortcutClient({
      apiBase: "https://api.example.com/",
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://agent.example.com/oauth/callback",
      state: {
        async setWorkspace(...args) {
          stored.push(args);
        },
      },
      async fetchImpl(url, options) {
        calls.push([url, options]);
        return jsonResponse({
          access_token: "access-token",
          access_token_expires_at: "2099-01-01T00:00:00Z",
          permission_id: "agent-member",
          refresh_token: "refresh-token",
          scope: "read comment-write",
          workspace2_id: "workspace-1",
          workspace2_slug: "acme",
        });
      },
    });

    const result = await client.exchangeAuthorizationCode("authorization-code");

    assert.equal(calls[0][0], "https://api.example.com/oauth-authorization-code-flow/token");
    assert.equal(calls[0][1].body.get("grant_type"), "authorization_code");
    assert.equal(calls[0][1].body.get("code"), "authorization-code");
    assert.equal(result.workspaceId, "workspace-1");
    assert.deepEqual(result.credentials.scopes, ["read", "comment-write"]);
    assert.deepEqual(stored, [["workspace-1", result.credentials]]);
  });

  it("uses v4 Story, Member, and Comment routes", async () => {
    const calls = [];
    const client = new ShortcutClient({
      apiBase: "https://api.example.com",
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://agent.example.com/oauth/callback",
      state: { async setWorkspace() {} },
      async fetchImpl(url, options) {
        calls.push([url, options]);
        return jsonResponse({ entity: { id: 123 } });
      },
    });
    const credentials = {
      accessToken: "access-token",
      expiresAt: "2099-01-01T00:00:00Z",
      memberId: "agent-member",
      refreshToken: "refresh-token",
      slug: "my workspace",
    };

    await client.getStory("workspace-1", credentials, 123);
    await client.getMember("workspace-1", credentials, "member/id");
    await client.postStoryComment("workspace-1", credentials, 123, {
      text: "@kurt hello",
      external_id: "team-cop:123",
    });

    assert.equal(calls[0][0], "https://api.example.com/api/v4/my%20workspace/stories/123?fields=team");
    assert.equal(calls[1][0], "https://api.example.com/api/v4/my%20workspace/members/member%2Fid?fields=mention_name");
    assert.equal(calls[2][0], "https://api.example.com/api/v4/my%20workspace/stories/123/comments?fields=id");
    assert.equal(calls[2][1].method, "POST");
    assert.deepEqual(JSON.parse(calls[2][1].body), {
      text: "@kurt hello",
      external_id: "team-cop:123",
    });
  });

  it("mutates shared credentials after refresh so later calls reuse the new token", async () => {
    const calls = [];
    const client = new ShortcutClient({
      apiBase: "https://api.example.com",
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://agent.example.com/oauth/callback",
      state: { async setWorkspace() {} },
      async fetchImpl(url, options) {
        calls.push([url, options]);
        if (url.endsWith("/oauth-authorization-code-flow/token")) {
          return jsonResponse({
            access_token: "new-access-token",
            access_token_expires_at: "2099-01-01T00:00:00Z",
            refresh_token: "new-refresh-token",
            scope: "read comment-write",
          });
        }
        return jsonResponse({ entity: { id: 123 } });
      },
    });
    const credentials = {
      accessToken: "old-access-token",
      expiresAt: "2000-01-01T00:00:00Z",
      memberId: "agent-member",
      refreshToken: "old-refresh-token",
      slug: "acme",
    };

    await client.getStory("workspace-1", credentials, 123);
    await client.getMember("workspace-1", credentials, "member-1");

    assert.equal(calls.filter(([url]) => url.endsWith("/token")).length, 1);
    assert.equal(credentials.accessToken, "new-access-token");
    assert.deepEqual(credentials.scopes, ["read", "comment-write"]);
    assert.equal(calls[2][1].headers.authorization, "Bearer new-access-token");
  });
});
