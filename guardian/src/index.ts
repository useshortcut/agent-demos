import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Env = {
  TOKENS: KVNamespace;
  CLIENT_ID: string;
  CLIENT_SECRET: string;
  REDIRECT_URI: string;
  WEBHOOK_SECRET: string;
  DEV?: string; // set to "true" in .dev.vars to downgrade signature failures to warnings
  SHORTCUT_API_BASE?: string; // override for local dev, defaults to https://api.app.shortcut.com
};

type WorkspaceCredentials = {
  token: string;
  slug: string;
  refreshToken: string;
  expiresAt: string; // ISO8601 — access_token_expires_at from token response
  memberId: string; // the agent's own permission_id — used to ignore its own edits
};

// --- Observer webhook (v2 envelope) ----------------------------------------

// Actions identify what changed but carry no diff, so the worker re-reads the
// story from the API and asks the history endpoint what the previous state was.
type ObserverAction = {
  action: 'create' | 'update' | 'delete';
  id: number | string;
  entity_type: string;
  global_id: string;
  uri: string | null;
};

type ObserverActor = {
  displayable_name: string;
  member_id?: string;
  automation_id?: string;
  webhook_id?: string;
};

type ObserverPayload = {
  id: string;
  version: 'v2';
  timestamp: string;
  actor: ObserverActor;
  workspace2: { id: string; url_slug: string };
  installation_id: string;
  actions: ObserverAction[];
};

// --- Shortcut v4 API shapes ------------------------------------------------

type SlimRef<Id = number> = { id: Id; entity_type: string; name?: string };

type Story = {
  id: number;
  name: string;
  team: SlimRef | null;
  workflow_state: SlimRef | null;
};

type WorkflowState = {
  id: number;
  name: string;
  type: 'unstarted' | 'started' | 'done';
};

type StoryComment = {
  id: number | null;
  text: string | null;
  deleted: boolean;
  author: SlimRef<string> | null;
};

type HistoryChange = {
  attribute: string;
  timestamp: string;
  adds: SlimRef[];
  removes: SlimRef[];
};

type Member = { id: string; mention_name: string; name: string };

// v4 list endpoints are page-based and default to 10 items per page.
type ListEnvelope<T> = {
  entities: T[];
  current_page: number;
  total_pages: number;
};

// ---------------------------------------------------------------------------
// The warning
// ---------------------------------------------------------------------------

// Recognising our own past warning is what makes this fire once per story.
// The marker is part of the visible sentence so the check needs no hidden
// markup, and it survives someone editing the rest of the comment.
const WARNING_MARKER = 'Stories need a team before being started!';

const warningText = (mention: string) =>
  `${mention} ${WARNING_MARKER} Please add a team and start again!`;

// A stale cache would let a newly-created "started" state slip through, so the
// list of started states is re-read hourly rather than pinned for the lifetime
// of the installation.
const STARTED_STATES_TTL_SECONDS = 3600;

// ---------------------------------------------------------------------------
// Session — credentials for one workspace, refreshed in place
// ---------------------------------------------------------------------------

type Session = {
  env: Env;
  kv: KVNamespace;
  workspaceId: string;
  creds: WorkspaceCredentials;
};

function shortcutApiBase(env: Env) {
  return env.SHORTCUT_API_BASE ?? 'https://api.app.shortcut.com';
}

// ---------------------------------------------------------------------------
// KV helpers
// ---------------------------------------------------------------------------

async function getCredentials(kv: KVNamespace, workspaceId: string): Promise<WorkspaceCredentials | null> {
  const raw = await kv.get(`creds:${workspaceId}`);
  return raw ? (JSON.parse(raw) as WorkspaceCredentials) : null;
}

async function storeCredentials(kv: KVNamespace, workspaceId: string, creds: WorkspaceCredentials) {
  await kv.put(`creds:${workspaceId}`, JSON.stringify(creds));
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

async function refreshCredentials(s: Session): Promise<WorkspaceCredentials | null> {
  console.log(`Refreshing token for workspace ${s.workspaceId}`);
  const res = await fetch(`${shortcutApiBase(s.env)}/oauth-authorization-code-flow/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: s.creds.refreshToken,
      client_id: s.env.CLIENT_ID,
      client_secret: s.env.CLIENT_SECRET,
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
    slug: s.creds.slug,
    refreshToken: data.refresh_token,
    expiresAt: data.access_token_expires_at,
    memberId: s.creds.memberId, // preserved from the original OAuth flow
  };

  await storeCredentials(s.kv, s.workspaceId, updated);
  s.creds = updated;
  return updated;
}

function isExpiringSoon(creds: WorkspaceCredentials): boolean {
  if (!creds.expiresAt) return false;
  return new Date(creds.expiresAt).getTime() < Date.now() + 5 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Shortcut v4 API (with auto-refresh on 401)
// ---------------------------------------------------------------------------

async function apiFetch(s: Session, method: string, path: string, body?: unknown): Promise<Response> {
  if (isExpiringSoon(s.creds)) await refreshCredentials(s);

  const url = `${shortcutApiBase(s.env)}/api/v4/${s.creds.slug}${path}`;
  const init = (): RequestInit => ({
    method,
    headers: {
      Authorization: `Bearer ${s.creds.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  let res = await fetch(url, init());

  // The token can expire between the check above and the call itself.
  if (res.status === 401) {
    if (!(await refreshCredentials(s))) return res;
    res = await fetch(url, init());
  }
  return res;
}

async function apiJson<T>(s: Session, method: string, path: string, body?: unknown): Promise<T | null> {
  const res = await apiFetch(s, method, path, body);
  if (!res.ok) {
    console.error(`${method} ${path} -> ${res.status} ${await res.text()}`);
    return null;
  }
  return (await res.json()) as T;
}

/** Walks every page of a v4 list endpoint. */
async function listAll<T>(s: Session, path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page += 1) {
    const sep = path.includes('?') ? '&' : '?';
    const envelope = await apiJson<ListEnvelope<T>>(s, 'GET', `${path}${sep}limit=100&page=${page}`);
    if (!envelope) break;
    out.push(...envelope.entities);
    if (page >= envelope.total_pages) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Guardian logic
// ---------------------------------------------------------------------------

/**
 * Ids of every workflow state of type "started", cached per workspace.
 * A story's `workflow_state` is a slim reference without a `type`, so the
 * types have to come from the workflow-states collection.
 */
async function startedStateIds(s: Session): Promise<Set<number>> {
  const cacheKey = `started-states:${s.workspaceId}`;
  const cached = await s.kv.get(cacheKey);
  if (cached) return new Set(JSON.parse(cached) as number[]);

  const states = await listAll<WorkflowState>(s, '/workflow-states');
  // Don't cache a failed lookup as "no started states" — that would silently
  // disable the agent for an hour.
  if (states.length === 0) return new Set();

  const ids = states.filter((state) => state.type === 'started').map((state) => state.id);
  await s.kv.put(cacheKey, JSON.stringify(ids), { expirationTtl: STARTED_STATES_TTL_SECONDS });
  return new Set(ids);
}

/** True if this agent has already warned on the story. */
async function alreadyWarned(s: Session, storyId: number): Promise<boolean> {
  const comments = await listAll<StoryComment>(s, `/stories/${storyId}/comments`);
  return comments.some(
    (comment) =>
      !comment.deleted &&
      comment.author?.id === s.creds.memberId &&
      (comment.text ?? '').includes(WARNING_MARKER),
  );
}

/**
 * The state the story was in before it landed in `currentStateId`.
 *
 * Observer payloads carry no diff, so the move has to be reconstructed from
 * story history. The newest `workflow_state` change is only trusted when what
 * it added matches where the story is now — otherwise it describes some older
 * move and its `removes` would send the story somewhere it never was.
 */
async function previousWorkflowStateId(
  s: Session,
  storyId: number,
  currentStateId: number,
): Promise<number | null> {
  const history = await apiJson<{ changes: HistoryChange[] }>(
    s,
    'GET',
    `/stories/${storyId}/history?fields=workflow_state&limit=1`,
  );

  const latest = history?.changes?.find((change) => change.attribute === 'workflow_state');
  if (!latest || latest.adds[0]?.id !== currentStateId) return null;
  return latest.removes[0]?.id ?? null;
}

async function resolveActorMention(s: Session, actor: ObserverActor): Promise<string> {
  if (!actor.member_id) return actor.displayable_name;
  const member = await apiJson<Member>(s, 'GET', `/members/${actor.member_id}`);
  // Falling back to the display name keeps the comment readable even though it
  // won't render as a real mention.
  return member?.mention_name ? `@${member.mention_name}` : actor.displayable_name;
}

/**
 * Warn and revert if the story is sitting in a started state with no team.
 * Safe to call for any updated story — every guard exits quietly.
 */
async function guardStory(s: Session, storyId: number, actorMention: () => Promise<string>) {
  const story = await apiJson<Story>(s, 'GET', `/stories/${storyId}`);
  if (!story) return;

  if (story.team) return; // has a team — nothing to enforce

  const currentStateId = story.workflow_state?.id;
  if (!currentStateId) return;

  const started = await startedStateIds(s);
  if (!started.has(currentStateId)) return; // not a started state

  if (await alreadyWarned(s, storyId)) {
    console.log(`Story ${storyId} already warned, leaving it alone`);
    return;
  }

  const previousStateId = await previousWorkflowStateId(s, storyId, currentStateId);

  const posted = await apiJson<StoryComment>(s, 'POST', `/stories/${storyId}/comments`, {
    text: warningText(await actorMention()),
  });
  if (!posted) {
    // Without the comment there is no record of the warning, so a revert here
    // would look like the story moving on its own — and would repeat forever.
    console.error(`Could not comment on story ${storyId}, skipping revert`);
    return;
  }

  if (previousStateId === null) {
    // Nothing to revert to: the story was created directly into a started
    // state, or its history has been trimmed. The comment still stands.
    console.warn(`No previous workflow state for story ${storyId}, warned only`);
    return;
  }

  const reverted = await apiJson<Story>(s, 'PATCH', `/stories/${storyId}`, {
    workflow_state_id: previousStateId,
  });
  console.log(
    reverted
      ? `Story ${storyId} reverted to workflow state ${previousStateId}`
      : `Story ${storyId} warned but revert to ${previousStateId} failed`,
  );
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
  return crypto.subtle.verify('HMAC', key, hexToBytes(signature), new TextEncoder().encode(body));
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

/** OAuth callback — exchanges the code for tokens and stores them per workspace. */
app.get('/oauth/callback', async (c) => {
  const error = c.req.query('error');
  if (error) {
    const description = c.req.query('error_description');
    console.error(`OAuth error: ${error} — ${description}`);
    return c.html(
      `<h2>&#10060; Authorization failed</h2>
       <p><strong>${error}</strong>: ${description ?? 'No description provided.'}</p>
       <p>Please close this tab and try connecting again.</p>`,
      400,
    );
  }

  const code = c.req.query('code');
  if (!code) return c.text('Missing code', 400);

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
    console.error('Token exchange failed', await res.text());
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

  console.log(`Connected workspace: ${data.workspace2_slug} (${data.workspace2_id})`);
  return c.html(
    `<h2>✅ Connected!</h2>
     <p>Workspace <strong>${data.workspace2_slug}</strong> is now guarded.</p>
     <p>You can close this tab.</p>`,
  );
});

/**
 * Observer webhook — verifies the signature, then checks every updated story
 * off the request path so Shortcut isn't waiting on the Shortcut API.
 */
app.post('/webhook', async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header('Payload-Signature') ?? '';

  if (c.env.WEBHOOK_SECRET) {
    const valid = await verifySignature(c.env.WEBHOOK_SECRET, rawBody, signature);
    if (!valid) {
      if (c.env.DEV === 'true') {
        console.warn('Dev mode: invalid webhook signature — proceeding anyway');
      } else {
        console.error('Invalid webhook signature');
        return c.json({ error: 'Invalid signature' }, 401);
      }
    }
  } else {
    console.warn('No WEBHOOK_SECRET configured — skipping signature verification');
  }

  let payload: ObserverPayload & { type?: string };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  // Validation pings carry no workspace.
  if (payload.type === 'validation') return c.json({ ok: true });
  if (!Array.isArray(payload.actions)) return c.json({ ok: true });

  const workspaceId = payload.workspace2.id;
  const creds = await getCredentials(c.env.TOKENS, workspaceId);
  if (!creds) {
    console.warn(`No credentials for workspace ${workspaceId}`);
    return c.json({ ok: true });
  }

  // The comment and the revert both come back as observer deliveries. Ignoring
  // our own edits is the first line of defence against reacting to ourselves;
  // the already-warned check is the second.
  if (payload.actor.member_id && payload.actor.member_id === creds.memberId) {
    return c.json({ ok: true });
  }

  const storyIds = [
    ...new Set(
      payload.actions
        .filter((action) => action.entity_type === 'story' && action.action === 'update')
        .map((action) => Number(action.id)),
    ),
  ];
  if (storyIds.length === 0) return c.json({ ok: true });

  const session: Session = { env: c.env, kv: c.env.TOKENS, workspaceId, creds };

  // Resolved at most once per delivery, and only if a story actually trips.
  let mention: Promise<string> | undefined;
  const actorMention = () => (mention ??= resolveActorMention(session, payload.actor));

  // Each story is checked in sequence so they share one refreshed token.
  c.executionCtx.waitUntil(
    (async () => {
      for (const storyId of storyIds) {
        try {
          await guardStory(session, storyId, actorMention);
        } catch (err) {
          console.error(`Error guarding story ${storyId}:`, err);
        }
      }
    })(),
  );

  return c.json({ ok: true });
});

app.get('/', async (c) => {
  const keys = await c.env.TOKENS.list({ prefix: 'creds:' });
  const workspaces = await Promise.all(
    keys.keys.map(async (key) => {
      const raw = await c.env.TOKENS.get(key.name);
      if (!raw) return { key: key.name, value: null };
      const parsed = JSON.parse(raw) as WorkspaceCredentials;
      return {
        key: key.name,
        slug: parsed.slug,
        hasToken: !!parsed.token,
        hasRefreshToken: !!parsed.refreshToken,
        hasMemberId: !!parsed.memberId,
        expiresAt: parsed.expiresAt ?? null,
      };
    }),
  );
  return c.json({ status: 'ok', service: 'Shortcut Guardian Agent', workspaces });
});

export default app;
