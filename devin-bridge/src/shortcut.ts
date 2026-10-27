import {
  ShortcutOAuth,
  ShortcutOAuthError,
  ShortcutV4Client,
  grantedScopes,
  isShortcutV4RequestError,
  summarizeShortcutV4Error,
  type FullRequestParams,
  type ShortcutOAuthRefreshTokens,
  type ShortcutOAuthTokens,
} from '@shortcut/client/v4';
import type { ShortcutAgentSession, ShortcutAgentSessionExternalUrl } from '@shortcut/client/webhooks';
import type { Activity } from './bridge';
import { retryAfterMs } from './http';
import type { Env } from './index';

export type Credentials = {
  token: string;
  slug: string;
  refreshToken: string;
  expiresAt: string;
  memberId: string;
  scopes: string[] | null;
};

const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_PATH = '/oauth-authorization-code-flow/token';

/** Every connected workspace spends this deployment's Devin organization, so only listed workspaces are served. */
export const workspaceAllowed = (env: Env, workspaceId: string) =>
  workspaceId !== '' && (env.ALLOWED_WORKSPACE_IDS ?? '').split(',').map((id) => id.trim()).includes(workspaceId);

/** Shortcut refused the refresh token, so this workspace's calls cannot succeed until it is activated again. */
export class RefreshRejectedError extends Error {
  constructor() {
    super('Shortcut rejected the token refresh');
  }
}

const apiBase = (env: Env) => env.SHORTCUT_API_BASE ?? 'https://api.app.shortcut.com';

export function oauthClient(env: Env) {
  return new ShortcutOAuth({ clientId: env.CLIENT_ID, clientSecret: env.CLIENT_SECRET, redirectUri: env.REDIRECT_URI, baseUrl: apiBase(env), timeoutMs: REQUEST_TIMEOUT_MS });
}

export function credentialsFromTokens(tokens: ShortcutOAuthTokens | ShortcutOAuthRefreshTokens, previous?: Credentials): Credentials {
  return {
    token: tokens.access_token,
    slug: tokens.workspace2_slug ?? previous?.slug ?? '',
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.access_token_expires_at,
    memberId: tokens.permission_id ?? previous?.memberId ?? '',
    scopes: typeof tokens.scope === 'string' ? grantedScopes(tokens) : previous?.scopes ?? null,
  };
}

const identifierCode = (code: unknown) => (typeof code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? { code } : {});

export function logFailure(error: unknown): void {
  const summary = summarizeShortcutV4Error(error);
  if (summary) console.error('Shortcut request rejected', summary);
  else if (error instanceof RefreshRejectedError) console.error('Shortcut rejected the token refresh; activate the agent again');
  else if (error instanceof ShortcutOAuthError) console.error('Shortcut request rejected', { method: 'POST', path: TOKEN_PATH, status: error.status, ...identifierCode(error.error) });
  else console.error('Shortcut request failed', { timeoutMs: REQUEST_TIMEOUT_MS });
}

function workspace(env: Env, workspaceId: string, path: string, init?: RequestInit): Promise<Response> {
  return env.WORKSPACES.get(env.WORKSPACES.idFromName(workspaceId)).fetch(new Request(`https://workspace${path}`, init));
}

export async function storeCredentials(env: Env, workspaceId: string, credentials: Credentials): Promise<void> {
  const response = await workspace(env, workspaceId, '/credentials', { method: 'PUT', body: JSON.stringify(credentials) });
  if (!response.ok) throw new Error('Storing credentials failed');
}

export async function loadCredentials(env: Env, workspaceId: string): Promise<Credentials | null> {
  const response = await workspace(env, workspaceId, '/credentials');
  return response.ok ? response.json<Credentials>() : null;
}

export type Failure =
  | { kind: 'conflict' }
  | { kind: 'closed' }
  | { kind: 'revoked' }
  | { kind: 'rejected'; status: number }
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'transient' };

export type Outcome<T = undefined> = { kind: 'ok'; value: T } | Failure;

export function classifyShortcutFailure(error: unknown): Failure {
  if (error instanceof RefreshRejectedError) return { kind: 'revoked' };
  if (!isShortcutV4RequestError(error)) return { kind: 'transient' };
  const { status } = error;
  if (status === 429) return { kind: 'rate_limited', retryAfterMs: retryAfterMs(error.headers.get('Retry-After'), Date.now()) };
  if (status === 409) return { kind: 'conflict' };
  if (status === 401 || status === 403 || status === 404) return { kind: 'closed' };
  if (status === 408 || status === 425) return { kind: 'transient' };
  if (status >= 400 && status < 500) return { kind: 'rejected', status };
  return { kind: 'transient' };
}

export function shortcutSessions(env: Env, workspaceId: string, credentials: Credentials) {
  let token = credentials.token;
  const client = new ShortcutV4Client({
    token,
    baseUrl: apiBase(env),
    timeoutMs: REQUEST_TIMEOUT_MS,
    refresh: {
      expiresAt: credentials.expiresAt,
      run: async () => {
        const response = await workspace(env, workspaceId, '/refresh', { method: 'POST', body: JSON.stringify({ token, workspaceId }) });
        if (response.status === 401) throw new RefreshRejectedError();
        if (!response.ok) throw new Error('Token refresh failed');
        const refreshed = await response.json<Credentials>();
        token = refreshed.token;
        return { token: refreshed.token, expiresAt: refreshed.expiresAt };
      },
    },
  });
  const base = `/api/v4/${encodeURIComponent(credentials.slug)}/agent-sessions`;
  const send = <T>(method: string, path: string, body?: unknown) =>
    client.request<T>({ path: `${base}${path}`, method, body, type: 'application/json' as FullRequestParams['type'], secure: true, format: 'json' });
  const attempt = async <T>(run: () => Promise<T>): Promise<Outcome<T>> => {
    try {
      return { kind: 'ok', value: await run() };
    } catch (error) {
      logFailure(error);
      return classifyShortcutFailure(error);
    }
  };

  return {
    ensureSubscribed: () => attempt(() => send('PUT', '/subscription', { enabled: true })),

    getSession: (id: string) => attempt(() => send<ShortcutAgentSession>('GET', `/${encodeURIComponent(id)}`)),

    setExternalUrls: (id: string, version: number, externalUrls: ShortcutAgentSessionExternalUrl[]) =>
      attempt(() => send('PATCH', `/${encodeURIComponent(id)}`, { version, external_urls: externalUrls })),

    postActivity: (id: string, { key, turn, content, ephemeral }: Activity) =>
      attempt(() => send('POST', `/${encodeURIComponent(id)}/activities`, { idempotency_key: key, turn, content, ...(ephemeral ? { ephemeral } : {}) })),
  };
}

export type ShortcutSessions = ReturnType<typeof shortcutSessions>;
