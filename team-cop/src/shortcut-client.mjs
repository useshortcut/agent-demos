import { createHash } from "node:crypto";
import {
  ShortcutOAuth,
  ShortcutOAuthError,
  ShortcutV4Client,
  grantedScopes,
  summarizeShortcutV4Error,
} from "@shortcut/client/v4";

export class ShortcutApiError extends Error {
  constructor(message, { body, status }) {
    super(message);
    this.name = "ShortcutApiError";
    this.body = body;
    this.status = status;
  }
}

function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function tokenErrorDetails(error) {
  let hint;

  if (error.error === "invalid_client") {
    hint =
      "Verify the local credentials match this Agent Application and the API environment.";
  } else if (error.error === "invalid_grant") {
    hint =
      "The authorization code may be expired or already used, or REDIRECT_URI may not exactly match the saved URI.";
  }

  return {
    error: error.error,
    ...(typeof error.errorDescription === "string" ? { errorDescription: error.errorDescription } : {}),
    ...(hint ? { hint } : {}),
    status: error.status,
  };
}

// The library aborts each request, including reading its body, after this long.
const REQUEST_TIMEOUT_MS = 15_000;

// Unrequested fields are never returned; `deleted` marks tombstones.
const COMMENT_FIELDS = "id,author,deleted";

export class ShortcutClient {
  constructor({ apiBase, clientId, clientSecret, fetchImpl = globalThis.fetch.bind(globalThis), logger = console, redirectUri, state }) {
    this.apiBase = apiBase.replace(/\/$/, "");
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.logger = logger;
    this.redirectUri = redirectUri;
    this.state = state;
    this.fetch = fetchImpl;
  }

  #oauth() {
    return new ShortcutOAuth({
      baseUrl: this.apiBase,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      fetch: this.fetch,
      redirectUri: this.redirectUri,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  }

  async #tokenRequest(grantType, request) {
    const diagnostics = {
      apiBase: this.apiBase,
      clientIdFingerprint: fingerprint(this.clientId),
      grantType,
      ...(grantType === "authorization_code" ? { redirectUri: this.redirectUri } : {}),
    };
    this.logger.info?.("Shortcut OAuth token request", diagnostics);

    let token;
    try {
      token = await request(this.#oauth());
    } catch (error) {
      if (!(error instanceof ShortcutOAuthError)) throw error;
      this.logger.error?.("Shortcut OAuth token request rejected", {
        ...diagnostics,
        ...tokenErrorDetails(error),
      });
      throw new ShortcutApiError(`Shortcut token request failed with HTTP ${error.status}`, {
        body: { error: error.error, error_description: error.errorDescription },
        status: error.status,
      });
    }
    this.logger.info?.("Shortcut OAuth token request accepted", {
      ...diagnostics,
      grantedScopes: grantedScopes(token),
    });
    return token;
  }

  async exchangeAuthorizationCode(code) {
    const token = await this.#tokenRequest("authorization_code", (oauth) => oauth.exchangeAuthorizationCode(code));
    const credentials = {
      accessToken: token.access_token,
      expiresAt: token.access_token_expires_at,
      memberId: token.permission_id ?? "",
      refreshToken: token.refresh_token,
      scopes: grantedScopes(token),
      slug: token.workspace2_slug,
    };

    await this.state.setWorkspace(token.workspace2_id, credentials);
    return { capabilities: token.capabilities ?? null, credentials, workspaceId: token.workspace2_id };
  }

  async #refresh(workspaceId, credentials) {
    const token = await this.#tokenRequest("refresh_token", (oauth) => oauth.refreshAccessToken(credentials.refreshToken));
    Object.assign(credentials, {
      accessToken: token.access_token,
      expiresAt: token.access_token_expires_at,
      refreshToken: token.refresh_token,
      // An older grant may not report its scopes; never forget the known ones.
      scopes: typeof token.scope === "string" ? grantedScopes(token) : credentials.scopes,
    });
    await this.state.setWorkspace(workspaceId, credentials);
    return credentials;
  }

  // Runs `operation(workspaceApi, client)`. The library rotates the token
  // itself: before a request within five minutes of expiry, and once more
  // after a 401, then retries the request.
  async #authorized(workspaceId, credentials, operation) {
    const client = new ShortcutV4Client({
      baseUrl: this.apiBase,
      fetch: this.fetch,
      timeoutMs: REQUEST_TIMEOUT_MS,
      token: credentials.accessToken,
      refresh: {
        expiresAt: credentials.expiresAt,
        run: async () => {
          const refreshed = await this.#refresh(workspaceId, credentials);
          return { token: refreshed.accessToken, expiresAt: refreshed.expiresAt };
        },
      },
    });
    try {
      return await operation(client.workspace(credentials.slug), client);
    } catch (error) {
      // Method, pathname, status, and identifier-shaped `tag`/`error` codes
      // only: never the body, the query (cursors), or headers.
      const summary = summarizeShortcutV4Error(error);
      if (!summary) throw error;
      this.logger.error?.("Shortcut API request rejected", summary);
      throw new ShortcutApiError(`Shortcut API request failed with HTTP ${error.status}`, {
        body: error.error,
        status: error.status,
      });
    }
  }

  async getStory(workspaceId, credentials, storyId) {
    const { entity } = await this.#authorized(workspaceId, credentials,
      (ws) => ws.getStory(storyId, { fields: "team" }));
    return entity;
  }

  // Returns this agent's existing live comment on the Story, or null. The
  // Story's current comments are authoritative, not a cached reminder flag.
  // `paginate` follows v4's `next_page_url` cursors, restricted to this API
  // origin, and throws rather than finishing on an incomplete or looping list.
  async findOwnComment(workspaceId, credentials, storyId) {
    if (typeof credentials.memberId !== "string" || !credentials.memberId.trim()) {
      throw new Error("Missing Team Cop member ID; cannot check prior comments");
    }
    return this.#authorized(workspaceId, credentials,
      async (ws, client) => {
        const comments = client.paginate(ws.listStoryComments(storyId, { fields: COMMENT_FIELDS, limit: 100 }));
        for await (const item of comments) {
          // v4 lists deleted comments "with minimal information": `deleted` is true and the id may be null.
          if (item.id != null && !item.deleted && item.author?.id === credentials.memberId) return item;
        }
        return null;
      });
  }

  // Posts the comment unless this agent has already commented on the Story.
  async postStoryComment(workspaceId, credentials, storyId, comment) {
    const existing = await this.findOwnComment(workspaceId, credentials, storyId);
    if (existing) return { ...existing, alreadyCommented: true };
    const { entity } = await this.#authorized(workspaceId, credentials,
      (ws) => ws.createStoryComment(storyId, comment, { fields: "id" }));
    return entity;
  }
}
