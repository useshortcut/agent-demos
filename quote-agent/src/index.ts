import { Hono } from 'hono';
import QUOTES from './quotes.json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Env = {
  TOKENS: KVNamespace;
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
};

type ShortcutAction = {
  action: 'create' | 'update' | 'delete';
  entity_type: string;
  id: number;
  changes?: Record<string, unknown>;
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
  return `${shortcutApiBase(env)}/api/v4/${slug}`;
}

// ---------------------------------------------------------------------------
// KV helpers
// ---------------------------------------------------------------------------

type ActionCounts = { create: number; update: number; delete: number };
type WorkspaceStats = Record<string, ActionCounts>;

async function getStats(kv: KVNamespace, workspaceId: string): Promise<WorkspaceStats> {
  const raw = await kv.get(`stats:${workspaceId}`);
  return raw ? (JSON.parse(raw) as WorkspaceStats) : {};
}

async function recordStats(kv: KVNamespace, workspaceId: string, actions: ShortcutAction[]) {
  const stats = await getStats(kv, workspaceId);
  for (const action of actions) {
    const { entity_type, action: verb } = action;
    if (!stats[entity_type]) stats[entity_type] = { create: 0, update: 0, delete: 0 };
    stats[entity_type][verb] = (stats[entity_type][verb] ?? 0) + 1;
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
  const res = await fetch(`${shortcutApiBase(env)}/oauth-authorization-code-flow/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: env.CLIENT_ID,
      client_secret: env.CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    console.error(`Token refresh failed: ${res.status} ${await res.text()}`);
    return null;
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    access_token_expires_at: string;
  };

  const updated: WorkspaceCredentials = {
    token: data.access_token,
    slug: creds.slug,
    refreshToken: data.refresh_token,
    expiresAt: data.access_token_expires_at,
    memberId: creds.memberId, // preserved from original OAuth flow
  };

  await storeCredentials(kv, workspaceId, updated);
  console.log(`Token refreshed for workspace ${workspaceId}, expires ${updated.expiresAt}`);
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

async function postComment(
  env: Env,
  kv: KVNamespace,
  workspaceId: string,
  creds: WorkspaceCredentials,
  entityType: string,
  entityId: number,
  text: string,
  parentCommentId?: number,
): Promise<boolean> {
  // Proactively refresh if expiring soon
  if (isExpiringSoon(creds)) {
    const refreshed = await refreshCredentials(env, kv, workspaceId, creds);
    if (refreshed) creds = refreshed;
  }

  const path = entityType === 'epic' ? `epics/${entityId}/comments` : `stories/${entityId}/comments`;
  const url = `${shortcutApi(env, creds.slug)}/${path}`;
  const body = parentCommentId ? { text, parent_comment_id: parentCommentId } : { text };

  let res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.token}` },
    body: JSON.stringify(body),
  });

  // Reactive refresh on 401 — token may have expired between check and call
  if (res.status === 401) {
    console.warn(`Got 401 posting comment, attempting token refresh for workspace ${workspaceId}`);
    const refreshed = await refreshCredentials(env, kv, workspaceId, creds);
    if (!refreshed) {
      console.error('Token refresh failed, giving up');
      return false;
    }
    creds = refreshed;
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.token}` },
      body: JSON.stringify(body),
    });
  }

  if (!res.ok) {
    console.error(`Failed to post comment: ${res.status} ${await res.text()}`);
  }
  return res.ok;
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

/**
 * OAuth callback — exchanges the code for tokens, stores them in KV
 * keyed by workspace_id.
 */
app.get('/oauth/callback', async (c) => {
  const error = c.req.query('error');
  const errorDescription = c.req.query('error_description');
  if (error) {
    console.error(`OAuth error: ${error} — ${errorDescription}`);
    return c.html(
      `<h2>&#10060; Authorization failed</h2>
       <p><strong>${error}</strong>: ${errorDescription ?? 'No description provided.'}</p>
       <p>Please close this tab and try connecting again.</p>`,
      400,
    );
  }

  const code = c.req.query('code');
  if (!code) return c.text('Missing code', 400);

  const returnedState = c.req.query('state');
  if (returnedState) {
    console.log(`OAuth state returned: ${returnedState}`);
  }

  const res = await fetch(`${shortcutApiBase(c.env)}/oauth-authorization-code-flow/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.CLIENT_ID,
      client_secret: c.env.CLIENT_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: c.env.REDIRECT_URI,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Token exchange failed', err);
    return c.text('Token exchange failed. Check worker logs.', 500);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    access_token_expires_at: string;
    permission_id: string;
    workspace2_id: string;
    workspace2_slug: string;
  };

  await storeCredentials(c.env.TOKENS, data.workspace2_id, {
    token: data.access_token,
    slug: data.workspace2_slug,
    refreshToken: data.refresh_token,
    expiresAt: data.access_token_expires_at,
    memberId: data.permission_id ?? '',
  });

  console.log(`Connected workspace: ${data.workspace2_slug} (${data.workspace2_id}), token expires ${data.access_token_expires_at}`);
  return c.html(
    `<h2>✅ Connected!</h2>
     <p>Workspace <strong>${data.workspace2_slug}</strong> is now connected.</p>
     <p>You can close this tab.</p>`,
  );
});

/**
 * Webhook — verifies HMAC signature, posts a random quote as a comment on
 * every story/epic action in the delivery.
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
  const workspaceId = payload.workspace2.id;
  const creds = await getCredentials(c.env.TOKENS, workspaceId);
  if (!creds) {
    console.warn(`No credentials for workspace ${workspaceId}`);
    return c.json({ ok: true });
  }

  if ('trigger' in payload) {
    // Interaction-triggered delivery
    const { trigger } = payload as ShortcutInteractionPayload;
    if (trigger.type === 'assigned') {
      console.log(`Agent assigned to ${trigger.entity_type} ${trigger.entity_id} in workspace ${workspaceId}`);
      await postComment(c.env, c.env.TOKENS, workspaceId, creds, trigger.entity_type, Number(trigger.entity_id), `💬 *${randomQuote()}*`);
    } else if (trigger.type === 'comment-reply') {
      console.log(`User replied to agent comment on ${trigger.entity_type} ${trigger.entity_id} in workspace ${workspaceId}`);
      await postComment(c.env, c.env.TOKENS, workspaceId, creds, trigger.entity_type, Number(trigger.entity_id), `💬 *${randomQuote()}*`, Number(trigger.parent_comment_id));
    } else if (trigger.type === 'mentioned') {
      console.log(`Agent mentioned in ${trigger.context} on ${trigger.entity_type} ${trigger.entity_id} in workspace ${workspaceId}`);
      // Reply in the same thread as the mention:
      // - If the mentioning comment is itself a reply (has comment_parent_id),
      //   use that parent as our parent (staying at depth 1, same thread root).
      // - If the mentioning comment is top-level, nest directly under it (depth 1).
      const parentCommentId =
        trigger.context === 'comment'
          ? trigger.comment_parent_id
            ? Number(trigger.comment_parent_id)
            : trigger.comment_id
              ? Number(trigger.comment_id)
              : undefined
          : undefined;
      await postComment(c.env, c.env.TOKENS, workspaceId, creds, trigger.entity_type, Number(trigger.entity_id), `💬 *${randomQuote()}*`, parentCommentId);
    } else {
      console.log(`Ignoring unknown trigger type=${(trigger as { type: string }).type} for workspace ${workspaceId}`);
    }
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
    }
    lines.push('');
  }
  if (keys.keys.length === 0) lines.push('No stats yet.');
  return c.text(lines.join('\n'));
});

app.get('/', async (c) => {
  const keys = await c.env.TOKENS.list();
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
      };
    }),
  );
  console.log('KV store contents:', JSON.stringify(creds, null, 2));
  return c.json({ status: 'ok', service: 'Shortcut Quote Agent', credentials: creds });
});

export default app;
