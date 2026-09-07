import { createHash } from "node:crypto";

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

function grantedScopes(token, fallback = []) {
  if (typeof token?.scope !== "string") return fallback;
  return token.scope
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function tokenErrorDetails(body, status) {
  const error = typeof body === "object" && body !== null ? body.error : null;
  const errorDescription =
    typeof body === "object" && body !== null ? body.error_description : null;
  let hint;

  if (error === "invalid_client") {
    hint =
      "Verify the local credentials match this Agent Application and the API environment.";
  } else if (error === "invalid_grant") {
    hint =
      "The authorization code may be expired or already used, or REDIRECT_URI may not exactly match the saved URI.";
  }

  return {
    error: typeof error === "string" ? error : "unknown_oauth_error",
    ...(typeof errorDescription === "string" ? { errorDescription } : {}),
    ...(hint ? { hint } : {}),
    status,
  };
}

function isExpiringSoon(credentials) {
  if (!credentials.expiresAt) return false;
  return new Date(credentials.expiresAt).getTime() < Date.now() + 5 * 60 * 1_000;
}

async function responseBody(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class ShortcutClient {
  constructor({ apiBase, clientId, clientSecret, fetchImpl = globalThis.fetch.bind(globalThis), logger = console, redirectUri, state, checkExistingComments = false }) {
    this.apiBase = apiBase.replace(/\/$/, "");
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.redirectUri = redirectUri;
    this.state = state;
    this.checkExistingComments = checkExistingComments;
  }

  async #tokenRequest(params) {
    const endpoint = `${this.apiBase}/oauth-authorization-code-flow/token`;
    const diagnostics = {
      apiBase: this.apiBase,
      clientIdFingerprint: fingerprint(this.clientId),
      grantType: params.grant_type,
      ...(params.redirect_uri ? { redirectUri: params.redirect_uri } : {}),
    };
    this.logger.info?.("Shortcut OAuth token request", diagnostics);

    const response = await this.fetch(endpoint, {
      signal: AbortSignal.timeout(15_000),
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
    const body = await responseBody(response);
    if (!response.ok) {
      this.logger.error?.("Shortcut OAuth token request rejected", {
        ...diagnostics,
        ...tokenErrorDetails(body, response.status),
      });
      throw new ShortcutApiError(`Shortcut token request failed with HTTP ${response.status}`, {
        body,
        status: response.status,
      });
    }
    this.logger.info?.("Shortcut OAuth token request accepted", {
      ...diagnostics,
      grantedScopes: grantedScopes(body),
      status: response.status,
    });
    return body;
  }

  async exchangeAuthorizationCode(code) {
    const token = await this.#tokenRequest({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: this.redirectUri,
    });
    const credentials = {
      accessToken: token.access_token,
      expiresAt: token.access_token_expires_at,
      memberId: token.permission_id ?? "",
      refreshToken: token.refresh_token,
      scopes: grantedScopes(token),
      slug: token.workspace2_slug,
    };

    await this.state.setWorkspace(token.workspace2_id, credentials);
    return { credentials, workspaceId: token.workspace2_id };
  }

  async #refresh(workspaceId, credentials) {
    const token = await this.#tokenRequest({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
    });
    const refreshed = {
      ...credentials,
      accessToken: token.access_token,
      expiresAt: token.access_token_expires_at,
      refreshToken: token.refresh_token,
      scopes: grantedScopes(token, credentials.scopes),
    };
    Object.assign(credentials, refreshed);
    await this.state.setWorkspace(workspaceId, credentials);
    return credentials;
  }

  async #authorizedRequest(workspaceId, credentials, path, options = {}) {
    let activeCredentials = credentials;
    if (isExpiringSoon(activeCredentials)) {
      activeCredentials = await this.#refresh(workspaceId, activeCredentials);
    }

    const request = (token) =>
      this.fetch(`${this.apiBase}/api/v4/${encodeURIComponent(activeCredentials.slug)}${path}`, {
        signal: AbortSignal.timeout(15_000),
        ...options,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...options.headers,
        },
      });

    let response = await request(activeCredentials.accessToken);
    if (response.status === 401) {
      activeCredentials = await this.#refresh(workspaceId, activeCredentials);
      response = await request(activeCredentials.accessToken);
    }

    const body = await responseBody(response);
    if (!response.ok) {
      throw new ShortcutApiError(`Shortcut API request failed with HTTP ${response.status}`, {
        body,
        status: response.status,
      });
    }
    return body?.entity ?? body;
  }

  getStory(workspaceId, credentials, storyId) {
    return this.#authorizedRequest(workspaceId, credentials, `/stories/${storyId}?fields=team`);
  }

  getMember(workspaceId, credentials, memberId) {
    return this.#authorizedRequest(
      workspaceId,
      credentials,
      `/members/${encodeURIComponent(memberId)}?fields=mention_name`,
    );
  }

  async postStoryComment(workspaceId, credentials, storyId, comment) {
    // Recover after a crash between posting and storing our local action receipt.
    // Match this event's external_id, so later starts still get their own reminder.
    if (this.checkExistingComments && comment.external_id) {
      for (let page = 1; ; page += 1) {
        const result = await this.#authorizedRequest(workspaceId, credentials,
          `/stories/${storyId}/comments?fields=id,external_id,author&limit=100&page=${page}`);
        if (!Array.isArray(result?.entities) || !Number.isInteger(result.total_pages)) {
          throw new Error("Invalid comment list response; cannot check prior reminder");
        }
        const existing = result.entities.find((item) =>
          item.external_id === comment.external_id && item.author?.id === credentials.memberId);
        if (existing) return existing;
        if (page >= result.total_pages) break;
      }
    }
    return this.#authorizedRequest(workspaceId, credentials, `/stories/${storyId}/comments?fields=id`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(comment),
    });
  }
}
