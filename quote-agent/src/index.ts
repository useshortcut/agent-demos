import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  ShortcutOAuth,
  ShortcutOAuthError,
  ShortcutV4Client,
  grantedScopes,
  isShortcutV4RequestError,
  summarizeShortcutV4Error,
  type ShortcutAgentCapabilities,
  type ShortcutOAuthTokens,
  type ShortcutV4Page,
} from '@shortcut/client/v4';
import {
  ShortcutWebhookClient,
  ShortcutWebhookError,
  isShortcutInteractionPayload,
  isShortcutValidationPayload,
  type ShortcutInteractionPayload,
} from '@shortcut/client/webhooks';
import QUOTES from './quotes.json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Env = {
  TOKENS: KVNamespace;
  QUOTE_DELIVERIES: DurableObjectNamespace;
  CLIENT_ID: string;
  CLIENT_SECRET: string;
  REDIRECT_URI: string;
  WEBHOOK_SECRET: string;
  SHORTCUT_API_BASE?: string; // override for local dev, defaults to https://api.app.shortcut.com
};

// Webhooks and OAuth are refused until every secret is set. A missing webhook
// secret must never mean "skip verification".
const REQUIRED_SECRETS = ['CLIENT_ID', 'CLIENT_SECRET', 'WEBHOOK_SECRET', 'REDIRECT_URI'] as const;
function configured(env: Env): boolean {
  return REQUIRED_SECRETS.every((key) => typeof env[key] === 'string' && env[key].trim() !== '');
}

type WorkspaceCredentials = {
  token: string;
  slug: string;
  refreshToken: string;
  expiresAt: string; // ISO8601 — access_token_expires_at from token response
  memberId: string;  // agent's permission_id — used to filter self-actions
  scopes?: string[] | null; // missing on older installations, unknown until OAuth/refresh
  capabilities?: ShortcutAgentCapabilities | null; // missing on records saved before it was reported
};

// Webhook payload types (observer, interaction, validation) come from
// @shortcut/client/webhooks; `ShortcutInteractionPayload` is what reaches the
// Durable Object after verification.

const randomQuote = () => (QUOTES as string[])[Math.floor(Math.random() * QUOTES.length)];

// ---------------------------------------------------------------------------
// Shortcut clients
// ---------------------------------------------------------------------------

function shortcutApiBase(env: Env) {
  return env.SHORTCUT_API_BASE ?? 'https://api.app.shortcut.com';
}

// The library aborts every API, pagination, and OAuth request, including
// reading its body, after this long, so a stalled upstream cannot keep the
// Durable Object busy.
const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_PATH = '/oauth-authorization-code-flow/token';

function oauthClient(env: Env) {
  return new ShortcutOAuth({
    clientId: env.CLIENT_ID,
    clientSecret: env.CLIENT_SECRET,
    redirectUri: env.REDIRECT_URI,
    baseUrl: shortcutApiBase(env),
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
}

// A refresh response without `scope` keeps the previous scopes; a legacy
// credential record with no scopes stays unknown (null) rather than empty.
function oauthScopes(tokens: Pick<ShortcutOAuthTokens, 'scope'>, previous?: string[] | null): string[] | null {
  if (typeof tokens.scope === 'string') return grantedScopes(tokens);
  return previous ?? null;
}

// Agent tokens report whether the app is assignable and mentionable, on the
// code exchange and on refresh. A response without them keeps what is known;
// a record saved before they were reported stays unknown (null), never off.
function oauthCapabilities(tokens: Pick<ShortcutOAuthTokens, 'capabilities'>, previous?: ShortcutAgentCapabilities | null): ShortcutAgentCapabilities | null {
  const { capabilities } = tokens;
  if (capabilities && typeof capabilities.assignable === 'boolean' && typeof capabilities.mentionable === 'boolean') {
    return { assignable: capabilities.assignable, mentionable: capabilities.mentionable };
  }
  return previous ?? null;
}

// This demo answers assignments and mentions, so it needs both. The builder
// can turn either off in Settings without a new token, so this is a snapshot.
function reportCapabilities(workspaceId: string, capabilities: ShortcutAgentCapabilities | null): void {
  if (capabilities && !(capabilities.assignable && capabilities.mentionable)) {
    console.warn('Quote Agent capabilities are off', { workspaceId, ...capabilities });
  }
}

/** A provider error code, only when it is an identifier and not free text. */
const errorCode = (code: unknown) => typeof code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? { code } : {};

// Do not log response text/messages, request bodies, query strings, cursors, or
// exception messages: all can contain credentials, OAuth codes, state, or user
// content. `summarizeShortcutV4Error` keeps only the method, pathname, status,
// and identifier-shaped `tag`/`error` codes of a rejected request.
function logFailure(error: unknown): void {
  const summary = summarizeShortcutV4Error(error);
  if (summary) console.error('Shortcut request rejected', summary);
  else if (error instanceof ShortcutOAuthError) console.error('Shortcut request rejected', { method: 'POST', path: TOKEN_PATH, status: error.status, ...errorCode(error.error) });
  else console.error('Shortcut request failed', { timeoutMs: REQUEST_TIMEOUT_MS });
}

// Carries only the status out of the request wrapper so the rejected Response
// (and its body) never reaches callers or logs.
class ShortcutRequestRejected extends Error {
  constructor(readonly status: number) {
    super('Shortcut API request rejected');
  }
}

// ---------------------------------------------------------------------------
// KV helpers
// ---------------------------------------------------------------------------

async function getCredentials(kv: KVNamespace, workspaceId: string): Promise<WorkspaceCredentials | null> {
  const raw = await kv.get(`creds:${workspaceId}`);
  if (!raw) return null;
  return JSON.parse(raw) as WorkspaceCredentials;
}

async function storeCredentials(kv: KVNamespace, workspaceId: string, creds: WorkspaceCredentials) {
  await kv.put(`creds:${workspaceId}`, JSON.stringify(creds));
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

/**
 * Exchanges a refresh token for a new access token and updates KV. The client
 * calls this itself; a refused rotation rejects with the library's error.
 */
async function refreshCredentials(
  env: Env,
  kv: KVNamespace,
  workspaceId: string,
  creds: WorkspaceCredentials,
): Promise<WorkspaceCredentials> {
  console.log(`Refreshing token for workspace ${workspaceId}`);
  const tokens = await oauthClient(env).refreshAccessToken(creds.refreshToken);
  const updated: WorkspaceCredentials = {
    token: tokens.access_token,
    slug: creds.slug,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.access_token_expires_at,
    memberId: creds.memberId, // preserved from original OAuth flow
    scopes: oauthScopes(tokens, creds.scopes),
    capabilities: oauthCapabilities(tokens, creds.capabilities),
  };
  await storeCredentials(kv, workspaceId, updated);
  console.log('Quote Agent OAuth refreshed', { workspaceId, scopes: updated.scopes ?? 'unknown', capabilities: updated.capabilities ?? 'unknown', expiresAt: updated.expiresAt });
  reportCapabilities(workspaceId, updated.capabilities ?? null);
  return updated;
}

// ---------------------------------------------------------------------------
// Shortcut API calls (with auto-refresh on 401)
// ---------------------------------------------------------------------------

type CommentSummary = { id?: number | null; external_id?: string | null; author?: { id: string } };
const COMMENT_FIELDS = 'id,external_id,author';

// One client per delivery. It rotates the token itself: before a request
// within five minutes of expiry, and once more after a 401, then retries.
class WorkspaceApi {
  private readonly client: ShortcutV4Client;

  constructor(env: Env, workspaceId: string, private readonly creds: WorkspaceCredentials) {
    this.client = new ShortcutV4Client({
      token: creds.token,
      baseUrl: shortcutApiBase(env),
      timeoutMs: REQUEST_TIMEOUT_MS,
      refresh: {
        expiresAt: creds.expiresAt,
        run: async () => {
          const refreshed = await refreshCredentials(env, env.TOKENS, workspaceId, creds);
          Object.assign(creds, refreshed);
          return { token: refreshed.token, expiresAt: refreshed.expiresAt };
        },
      },
    });
  }

  async alreadyPosted(entityType: string, entityId: number, marker: string): Promise<boolean> {
    if (!this.creds.memberId) throw new Error('Missing agent member ID for duplicate check');
    return this.request(async () => {
      const api = this.client.workspace(this.creds.slug);
      const query = { fields: COMMENT_FIELDS, limit: 100 };
      const first: Promise<ShortcutV4Page<CommentSummary>> = entityType === 'epic'
        ? api.listEpicComments(entityId, query) : api.listStoryComments(entityId, query);
      // paginate follows next_page_url with only cursor (+fields), stays on the
      // API origin, and throws on loops, unsafe links, or incomplete lists.
      for await (const comment of this.client.paginate(first)) {
        if (comment.id != null && comment.external_id === marker && comment.author?.id === this.creds.memberId) return true;
      }
      return false;
    });
  }

  async postComment(entityType: string, entityId: number, text: string, marker: string, parentId?: string): Promise<void> {
    const body = { text, external_id: marker, ...(parentId ? { parent_comment_id: Number(parentId) } : {}) };
    await this.request((): Promise<unknown> => {
      const api = this.client.workspace(this.creds.slug);
      return entityType === 'epic'
        ? api.createEpicComment(entityId, body, { fields: 'id' })
        : api.createStoryComment(entityId, body, { fields: 'id' });
    });
  }

  // The rejected Response (and its body) never reaches callers or logs; only
  // its status does.
  private async request<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      logFailure(error);
      if (isShortcutV4RequestError(error)) throw new ShortcutRequestRejected(error.status);
      throw new Error('Shortcut request failed or timed out');
    }
  }
}

// A single object per workspace serializes reads, token refresh, external writes,
// and durable receipts. KV alone cannot safely claim concurrent deliveries.
export class QuoteDeliveries {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private ctx: DurableObjectState, private env: Env) {}

  fetch(request: Request): Promise<Response> {
    const next = this.pending.then(() => this.process(request));
    this.pending = next.catch(() => undefined);
    return next;
  }

  private async process(request: Request): Promise<Response> {
    const payload = await request.json() as ShortcutInteractionPayload;
    const { trigger, workspace2: { id: workspaceId } } = payload;
    try {
      const creds = await getCredentials(this.env.TOKENS, workspaceId);
      if (!creds) throw new Error('Missing OAuth credentials');
      if (payload.actor?.member_id === creds.memberId) return Response.json({ ok: true });
      const key = JSON.stringify([payload.installation_id, workspaceId, payload.id]);
      if (await this.ctx.storage.get(`receipt:${key}`)) return Response.json({ ok: true, duplicate: true });
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
      const marker = `quote-agent:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
      const api = new WorkspaceApi(this.env, workspaceId, creds);
      const entityId = Number(trigger.entity_id);
      if (!await api.alreadyPosted(trigger.entity_type, entityId, marker)) {
        const parentId = trigger.type === 'comment-reply' ? trigger.parent_comment_id :
          trigger.type === 'mentioned' && trigger.context === 'comment' ? trigger.comment_parent_id || trigger.comment_id : undefined;
        await api.postComment(trigger.entity_type, entityId, `💬 *${randomQuote()}*`, marker, parentId);
      }
      // If execution stops after POST, the next delivery finds its marker in
      // current comments before retrying the effect. New interactions get new keys.
      await this.ctx.storage.put(`receipt:${key}`, { completedAt: new Date().toISOString() });
      return Response.json({ ok: true });
    } catch {
      console.error('Quote Agent delivery failed', { workspaceId, deliveryId: payload.id });
      return Response.json({ error: 'Delivery processing failed. Check Worker logs.' }, { status: 503 });
    }
  }
}

// ---------------------------------------------------------------------------
// Webhook body handling
// ---------------------------------------------------------------------------

// Deliveries are small; anything larger is not a delivery. Reading with a cap
// keeps an oversized body from being buffered and hashed in full.
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** The raw request body, or null if it exceeds the cap. */
async function readBody(request: Request): Promise<Uint8Array | null> {
  if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Env }>();
app.onError((_error, c) => {
  console.error('Quote Agent request failed', { method: c.req.method, path: c.req.path });
  return c.text('Request failed. Check Worker logs.', 500);
});
app.use('/oauth/callback', async (c, next) => {
  if (!configured(c.env)) return c.json({ error: 'Configure the worker secrets first' }, 503);
  await next();
});
app.use('/webhook', async (c, next) => {
  if (!configured(c.env)) return c.json({ error: 'Configure the worker secrets first' }, 503);
  await next();
});

/**
 * OAuth callback — exchanges the code for tokens, stores them in KV
 * keyed by workspace_id.
 */
app.get('/oauth/callback', async (c) => {
  const error = c.req.query('error');
  if (error) {
    console.error('Quote Agent OAuth authorization rejected');
    return c.html(
      `<h2>&#10060; Authorization failed</h2>
       <p>Please close this tab and try connecting again.</p>`,
      400,
    );
  }

  const code = c.req.query('code');
  if (!code) return c.text('Missing code', 400);

  console.log('Quote Agent OAuth callback received', { hasCode: true, hasState: !!c.req.query('state') });

  let tokens: ShortcutOAuthTokens;
  try {
    tokens = await oauthClient(c.env).exchangeAuthorizationCode(code);
  } catch (error) {
    logFailure(error);
    return c.text('Token exchange failed. Check worker logs.', 500);
  }

  const capabilities = oauthCapabilities(tokens);
  await storeCredentials(c.env.TOKENS, tokens.workspace2_id, {
    token: tokens.access_token,
    slug: tokens.workspace2_slug,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.access_token_expires_at,
    memberId: tokens.permission_id ?? '',
    scopes: oauthScopes(tokens),
    ...(capabilities ? { capabilities } : {}),
  });

  console.log('Quote Agent connected', { workspaceId: tokens.workspace2_id, scopes: oauthScopes(tokens) ?? 'unknown', capabilities: capabilities ?? 'unknown', expiresAt: tokens.access_token_expires_at });
  reportCapabilities(tokens.workspace2_id, capabilities);
  return c.html(
    `<h2>✅ Connected!</h2>
     <p>Your workspace is now connected.</p>
     <p>You can close this tab.</p>`,
  );
});

/**
 * Webhook — verifies the HMAC signature and delivery shape, posts a random
 * quote as a comment on each new interaction. Observer deliveries are
 * acknowledged and ignored.
 */
app.post('/webhook', async (c) => {
  const rawBody = await readBody(c.req.raw);
  if (rawBody === null) return c.json({ error: 'Payload too large' }, 413);

  // verifyBody checks size, signature (constant time), JSON, and the delivery
  // envelope before anything is parsed or acted on. verify(request) is not
  // used: it also insists on a JSON content-type header.
  let payload;
  try {
    ({ payload } = await new ShortcutWebhookClient(c.env.WEBHOOK_SECRET).verifyBody(rawBody, c.req.header('Payload-Signature')));
  } catch (error) {
    if (!(error instanceof ShortcutWebhookError)) throw error;
    if (error.status === 401) {
      console.error('Invalid webhook signature');
      return c.json({ error: 'Invalid signature' }, 401);
    }
    if (error.status === 413) return c.json({ error: 'Payload too large' }, 413);
    return c.json({ error: 'Invalid payload' }, error.status as ContentfulStatusCode);
  }

  // Validation pings from Shortcut have type='validation' and no workspace_id
  if (isShortcutValidationPayload(payload)) return c.json({ ok: true });

  // Observer deliveries carry `actions`; this agent only acts on interactions.
  // Acknowledging them without work also avoids reacting to its own comments.
  if (!isShortcutInteractionPayload(payload)) return c.json({ ok: true });

  const { trigger } = payload;
  if (!['story', 'epic'].includes(trigger.entity_type)) return c.json({ ok: true, ignored: true });
  if (!/^\d+$/.test(trigger.entity_id)) return c.json({ error: 'Invalid interaction identity' }, 400);
  const workspaceId = payload.workspace2.id;
  const id = c.env.QUOTE_DELIVERIES.idFromName(workspaceId);
  return c.env.QUOTE_DELIVERIES.get(id).fetch(new Request('https://internal/deliver', { method: 'POST', body: JSON.stringify(payload) }));
});

// Unauthenticated, so it says nothing about which workspaces are connected.
// Connected workspaces and their scopes are in the OAuth connect/refresh logs.
app.get('/', (c) => c.json({ status: 'ok', service: 'Shortcut Quote Agent' }));

export default app;
