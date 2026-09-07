import { Hono } from 'hono';
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
  DEV?: string; // set to "true" in .dev.vars to skip signature verification
  SHORTCUT_API_BASE?: string; // override for local dev, defaults to https://api.app.shortcut.com
};

type WorkspaceCredentials = {
  token: string;
  slug: string;
  refreshToken: string;
  expiresAt: string; // ISO8601 — access_token_expires_at from token response
  memberId: string;  // agent's permission_id — used to filter self-actions
  scopes?: string[] | null; // missing on older installations, unknown until OAuth/refresh
};

// One entry per tracked attribute the transaction touched, in the same shape
// as the v4 story history API (`attribute` / `adds` / `removes`).
type ShortcutChange = {
  attribute: string;
  adds: unknown[];
  removes: unknown[];
  truncated?: boolean;
};

type ShortcutAction = {
  action: 'create' | 'update' | 'delete';
  entity_type: string;
  id: number | string;
  global_id: string;
  app_url: string | null;
  /** @deprecated Frozen for legacy consumers — read `app_url`. */
  uri?: string | null;
  // Story update actions only. Absent means the diff was unavailable for this
  // delivery, not that nothing changed.
  changes?: ShortcutChange[];
};

// Observer delivery payload (webhook2)
type ShortcutObserverPayload = {
  workspace2: {
    id: string;
    url_slug: string;
  };
  actor?: {
    member_id?: string;
    displayable_name?: string;
  };
  actions: ShortcutAction[];
  references?: Array<{
    entity_type: string;
    id: number;
    mention_name?: string;
  }>;
};

type TriggerMap =
  | { type: 'assigned'; entity_type: string; entity_id: string }
  | { type: 'comment-reply'; entity_type: string; entity_id: string; comment_id: string; parent_comment_id: string }
  | { type: 'mentioned'; entity_type: string; entity_id: string; context: 'comment' | 'description'; comment_id?: string; comment_parent_id?: string };

// Interaction-triggered payload (agent-interaction-notifier) — same v2 envelope
// as observer but with a :trigger map instead of :actions
type ShortcutInteractionPayload = {
  id: string;
  version: 'v2';
  timestamp: string;
  workspace2: {
    id: string;
    url_slug: string;
  };
  installation_id: string;
  actor: {
    member_id: string;
    displayable_name: string;
  };
  trigger: TriggerMap;
};

type ShortcutWebhookPayload = ShortcutObserverPayload | ShortcutInteractionPayload;

const randomQuote = () => (QUOTES as string[])[Math.floor(Math.random() * QUOTES.length)];

// ---------------------------------------------------------------------------
// Shortcut API helpers
// ---------------------------------------------------------------------------

function shortcutApiBase(env: Env) {
  return env.SHORTCUT_API_BASE ?? 'https://api.app.shortcut.com';
}


function shortcutApi(env: Env, slug: string) {
  return `${shortcutApiBase(env)}/api/v4/${encodeURIComponent(slug)}`;
}

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_COMMENT_PAGES = 1_000;

function oauthScopes(data: { scope?: unknown; scopes?: unknown }, previous?: string[] | null): string[] | null {
  const value = data.scope ?? data.scopes;
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  if (Array.isArray(value) && value.every((scope) => typeof scope === 'string')) return value;
  return previous ?? null;
}

// Do not log response text/messages, request bodies, query strings, or exception
// messages: all can contain credentials, OAuth codes, state, or user content.
async function shortcutFetch(url: string, options: RequestInit, sensitive: string[] = []): Promise<Response> {
  const details = { method: options.method ?? 'GET', path: new URL(url).pathname };
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
      const codes: Record<string, string> = {};
      const body = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
      for (const key of ['tag', 'error', 'code']) {
        const value = body?.[key];
        if (typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value) &&
            !sensitive.some((secret) => secret && value.includes(secret))) codes[key] = value;
      }
      console.error('Shortcut request rejected', { ...details, status: response.status, ...codes });
    }
    return response;
  } catch {
    console.error('Shortcut request failed', { ...details, timeoutMs: REQUEST_TIMEOUT_MS });
    throw new Error('Shortcut request failed or timed out');
  }
}

// ---------------------------------------------------------------------------
// KV helpers
// ---------------------------------------------------------------------------

// `changed` tallies the attributes reported in update actions' `changes`.
type ActionCounts = { create: number; update: number; delete: number; changed?: Record<string, number> };
type WorkspaceStats = Record<string, ActionCounts>;

async function getStats(kv: KVNamespace, workspaceId: string): Promise<WorkspaceStats> {
  const raw = await kv.get(`stats:${workspaceId}`);
  return raw ? (JSON.parse(raw) as WorkspaceStats) : {};
}

async function recordStats(kv: KVNamespace, workspaceId: string, actions: ShortcutAction[]) {
  const stats = await getStats(kv, workspaceId);
  for (const action of actions) {
    const { entity_type, action: verb } = action;
    const counts = (stats[entity_type] ??= { create: 0, update: 0, delete: 0 });
    counts[verb] = (counts[verb] ?? 0) + 1;
    for (const change of action.changes ?? []) {
      const changed = (counts.changed ??= {});
      changed[change.attribute] = (changed[change.attribute] ?? 0) + 1;
    }
  }
  await kv.put(`stats:${workspaceId}`, JSON.stringify(stats));
}

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
 * Exchanges a refresh token for a new access token and updates KV.
 * Returns the updated credentials, or null if the refresh failed.
 */
async function refreshCredentials(
  env: Env,
  kv: KVNamespace,
  workspaceId: string,
  creds: WorkspaceCredentials,
): Promise<WorkspaceCredentials | null> {
  console.log(`Refreshing token for workspace ${workspaceId}`);
  const res = await shortcutFetch(`${shortcutApiBase(env)}/oauth-authorization-code-flow/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: env.CLIENT_ID,
      client_secret: env.CLIENT_SECRET,
    }),
  }, [creds.token, creds.refreshToken, env.CLIENT_SECRET]);

  if (!res.ok) {
    return null;
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    access_token_expires_at: string;
    scope?: unknown;
    scopes?: unknown;
  };

  const updated: WorkspaceCredentials = {
    token: data.access_token,
    slug: creds.slug,
    refreshToken: data.refresh_token,
    expiresAt: data.access_token_expires_at,
    memberId: creds.memberId, // preserved from original OAuth flow
    scopes: oauthScopes(data, creds.scopes),
  };

  await storeCredentials(kv, workspaceId, updated);
  console.log('Quote Agent OAuth refreshed', { workspaceId, scopes: updated.scopes ?? 'unknown', expiresAt: updated.expiresAt });
  return updated;
}

/**
 * Returns true if the access token expires within the next 5 minutes.
 */
function isExpiringSoon(creds: WorkspaceCredentials): boolean {
  if (!creds.expiresAt) return false;
  const expiresAt = new Date(creds.expiresAt).getTime();
  const fiveMinutesFromNow = Date.now() + 5 * 60 * 1000;
  return expiresAt < fiveMinutesFromNow;
}

// ---------------------------------------------------------------------------
// Shortcut API calls (with auto-refresh on 401)
// ---------------------------------------------------------------------------

async function apiRequest(
  env: Env,
  workspaceId: string,
  creds: WorkspaceCredentials,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  if (isExpiringSoon(creds)) {
    const refreshed = await refreshCredentials(env, env.TOKENS, workspaceId, creds);
    if (!refreshed) throw new Error('Token refresh failed');
    Object.assign(creds, refreshed);
  }
  const url = `${shortcutApi(env, creds.slug)}/${path}`;
  const request = () => shortcutFetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.token}` },
  }, [creds.token, creds.refreshToken, env.CLIENT_SECRET, new URL(url).searchParams.get('cursor') ?? '']);
  let res = await request();
  if (res.status === 401) {
    const refreshed = await refreshCredentials(env, env.TOKENS, workspaceId, creds);
    if (!refreshed) throw new Error('Token refresh failed');
    Object.assign(creds, refreshed);
    res = await request();
  }
  if (!res.ok) throw new Error('Shortcut API request rejected');
  return res;
}

async function alreadyPosted(env: Env, workspaceId: string, creds: WorkspaceCredentials, path: string, marker: string): Promise<boolean> {
  if (!creds.memberId) throw new Error('Missing agent member ID for duplicate check');
  const endpoint = new URL(`${shortcutApi(env, creds.slug)}/${path}`);
  const fields = 'id,external_id,author';
  let nextPath = `${path}?fields=${fields}&limit=100`;
  const cursors = new Set<string>();
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const result = await (await apiRequest(env, workspaceId, creds, nextPath)).json() as {
      entities: Array<{ id: number | null; external_id?: string; author?: { id: string } }>;
      current_page?: number; total_pages: number; next_page_url?: string | null;
    };
    const currentPage = result.current_page ?? page;
    if (!Array.isArray(result.entities) || !Number.isInteger(result.total_pages) || result.total_pages < 0 ||
        !Number.isInteger(currentPage) || currentPage !== page ||
        (result.total_pages === 0 ? result.entities.length > 0 || page !== 1 : currentPage > result.total_pages)) {
      throw new Error('Invalid comment pagination');
    }
    if (result.entities.some((comment) => comment.id != null && comment.external_id === marker && comment.author?.id === creds.memberId)) return true;
    if (result.next_page_url == null) {
      if (currentPage < result.total_pages) throw new Error('Incomplete comment pagination');
      return false;
    }
    if (typeof result.next_page_url !== 'string') throw new Error('Invalid next-page URL');
    const next = new URL(result.next_page_url, endpoint);
    if (next.origin !== endpoint.origin || next.pathname !== endpoint.pathname || next.username || next.password || next.hash ||
        [...next.searchParams.keys()].some((key) => key !== 'cursor' && key !== 'fields') || next.searchParams.getAll('cursor').length !== 1) {
      throw new Error('Unsafe comment pagination');
    }
    const cursor = next.searchParams.get('cursor');
    if (!cursor || cursors.has(cursor)) throw new Error('Repeated or empty comment cursor');
    cursors.add(cursor);
    nextPath = `${path}?cursor=${encodeURIComponent(cursor)}&fields=${fields}`;
  }
  throw new Error('Comment pagination exceeded page limit');
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
      const path = `${trigger.entity_type === 'epic' ? 'epics' : 'stories'}/${trigger.entity_id}/comments`;
      if (!await alreadyPosted(this.env, workspaceId, creds, path, marker)) {
        const parentId = trigger.type === 'comment-reply' ? trigger.parent_comment_id :
          trigger.type === 'mentioned' && trigger.context === 'comment' ? trigger.comment_parent_id || trigger.comment_id : undefined;
        await apiRequest(this.env, workspaceId, creds, `${path}?fields=id`, {
          method: 'POST',
          body: JSON.stringify({ text: `💬 *${randomQuote()}*`, external_id: marker,
            ...(parentId ? { parent_comment_id: Number(parentId) } : {}) }),
        });
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
// Webhook signature verification
// ---------------------------------------------------------------------------

async function verifySignature(secret: string, body: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const sigBytes = hexToBytes(signature);
  return crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(body));
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Env }>();
app.onError((_error, c) => {
  console.error('Quote Agent request failed', { method: c.req.method, path: c.req.path });
  return c.text('Request failed. Check Worker logs.', 500);
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

  const res = await shortcutFetch(`${shortcutApiBase(c.env)}/oauth-authorization-code-flow/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.CLIENT_ID,
      client_secret: c.env.CLIENT_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: c.env.REDIRECT_URI,
    }),
  }, [code, c.req.query('state') ?? '', c.env.CLIENT_SECRET]);

  if (!res.ok) {
    return c.text('Token exchange failed. Check worker logs.', 500);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    access_token_expires_at: string;
    permission_id: string;
    workspace2_id: string;
    workspace2_slug: string;
    scope?: unknown;
    scopes?: unknown;
  };

  await storeCredentials(c.env.TOKENS, data.workspace2_id, {
    token: data.access_token,
    slug: data.workspace2_slug,
    refreshToken: data.refresh_token,
    expiresAt: data.access_token_expires_at,
    memberId: data.permission_id ?? '',
    scopes: oauthScopes(data),
  });

  console.log('Quote Agent connected', { workspaceId: data.workspace2_id, scopes: oauthScopes(data) ?? 'unknown', expiresAt: data.access_token_expires_at });
  return c.html(
    `<h2>✅ Connected!</h2>
     <p>Your workspace is now connected.</p>
     <p>You can close this tab.</p>`,
  );
});

/**
 * Webhook — verifies HMAC signature, posts a random quote as a comment on
 * each new interaction. Observer deliveries only record stats.
 */
app.post('/webhook', async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header('Payload-Signature') ?? '';

  const isDev = c.env.DEV === 'true';
  if (c.env.WEBHOOK_SECRET) {
    const valid = await verifySignature(c.env.WEBHOOK_SECRET, rawBody, signature);
    if (!valid) {
      if (isDev) {
        console.warn('Dev mode: invalid webhook signature — proceeding anyway');
      } else {
        console.error('Invalid webhook signature');
        return c.json({ error: 'Invalid signature' }, 401);
      }
    }
  } else {
    console.warn('No WEBHOOK_SECRET configured — skipping signature verification');
  }

  let payload: ShortcutWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  // Validation pings from Shortcut have type='validation' and no workspace_id
  if ((payload as Record<string, unknown>).type === 'validation') {
    return c.json({ ok: true });
  }

  // Both payload types now use workspace2.id
  const workspaceId = payload.workspace2?.id;
  if (!workspaceId) return c.json({ error: 'Missing workspace' }, 400);

  if ('trigger' in payload) {
    const { trigger } = payload;
    if (!['assigned', 'comment-reply', 'mentioned'].includes(trigger?.type) ||
        !['story', 'epic'].includes(trigger?.entity_type)) return c.json({ ok: true, ignored: true });
    if (typeof payload.id !== 'string' || !payload.id || typeof payload.installation_id !== 'string' || !payload.installation_id ||
        !/^\d+$/.test(String(trigger.entity_id))) return c.json({ error: 'Invalid interaction identity' }, 400);
    const id = c.env.QUOTE_DELIVERIES.idFromName(workspaceId);
    return c.env.QUOTE_DELIVERIES.get(id).fetch(new Request('https://internal/deliver', { method: 'POST', body: JSON.stringify(payload) }));
  } else {
    // Observer delivery — record stats, ignore to avoid infinite loops
    console.log(`Observer delivery for workspace ${workspaceId}: ${payload.actions.length} actions`);
    await recordStats(c.env.TOKENS, workspaceId, payload.actions);
  }

  return c.json({ ok: true });
});

app.get('/stats', async (c) => {
  const keys = await c.env.TOKENS.list({ prefix: 'stats:' });
  const lines: string[] = ['Shortcut Agent — Action Stats', '==============================', ''];
  for (const key of keys.keys) {
    const workspaceId = key.name.replace('stats:', '');
    const stats = await getStats(c.env.TOKENS, workspaceId);
    lines.push(`Workspace: ${workspaceId}`);
    const sorted = Object.entries(stats).sort(([a], [b]) => a.localeCompare(b));
    for (const [entityType, counts] of sorted) {
      lines.push(`  ${entityType.padEnd(20)} create=${counts.create}  update=${counts.update}  delete=${counts.delete}`);
      const changed = Object.entries(counts.changed ?? {}).sort(([, a], [, b]) => b - a);
      if (changed.length > 0) {
        lines.push(`  ${''.padEnd(20)} changed: ${changed.map(([attribute, n]) => `${attribute}=${n}`).join('  ')}`);
      }
    }
    lines.push('');
  }
  if (keys.keys.length === 0) lines.push('No stats yet.');
  return c.text(lines.join('\n'));
});

app.get('/', async (c) => {
  const keys = await c.env.TOKENS.list({ prefix: 'creds:' });
  const creds = await Promise.all(
    keys.keys.map(async (k) => {
      const raw = await c.env.TOKENS.get(k.name);
      if (!raw) return { key: k.name, value: null };
      const parsed = JSON.parse(raw) as WorkspaceCredentials;
      return {
        key: k.name,
        slug: parsed.slug,
        hasToken: !!parsed.token,
        hasRefreshToken: !!parsed.refreshToken,
        hasMemberId: !!parsed.memberId,
        expiresAt: parsed.expiresAt ?? null,
        scopes: parsed.scopes ?? 'unknown',
      };
    }),
  );
  console.log('KV store contents:', JSON.stringify(creds, null, 2));
  return c.json({ status: 'ok', service: 'Shortcut Quote Agent', credentials: creds });
});

export default app;
