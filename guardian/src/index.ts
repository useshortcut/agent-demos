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
  memberId: string; // the agent's own permission_id — used to ignore its own edits
  scopes?: string[]; // absent for credentials issued before scope reporting
};

// --- Observer webhook (v2 envelope) ----------------------------------------

// One entry per tracked attribute a transaction touched, in the same shape as
// the v4 story history API: refs render as slim entities, everything else as
// plain scalars. A cardinality-one replacement is adds=[new] removes=[old];
// setting a previously-unset attribute has removes=[], clearing one has adds=[].
type ChangeEntry = {
  attribute: string;
  adds: ChangeValue[];
  removes: ChangeValue[];
  truncated?: boolean; // a string value was cut at 8,192 chars
};

type ChangeValue = SlimRef<number | string> | string | number | boolean;

type ObserverAction = {
  action: 'create' | 'update' | 'delete';
  id: number | string;
  entity_type: string;
  global_id: string;
  app_url: string | null;
  /** @deprecated Frozen for legacy consumers — read `app_url`. */
  uri?: string | null;
  // Story update actions only. `[]` means nothing tracked changed. An absent
  // key means the diff was unavailable for this delivery, never that nothing
  // changed — Guardian falls back to story history in that case.
  changes?: ChangeEntry[];
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

// Every v4 endpoint takes a `fields` query param. Unrequested fields are never
// calculated — a story rendered whole resolves its description markdown and
// every nested collection — so asking narrowly is worth doing on a hot path
// like this one, which reads a story for every move or team change in the
// workspace.
//
// Unknown field names are a 400, so each constant below is the exact field list
// for the type under it. Change one, change the other.

const STORY_FIELDS = 'team,workflow_state';
type Story = {
  team: SlimRef | null;
  workflow_state: SlimRef | null; // slim: id and name, no `type`
};

const WORKFLOW_STATE_FIELDS = 'id,type';
type WorkflowState = {
  id: number;
  type: 'unstarted' | 'started' | 'done';
};

const COMMENT_FIELDS = 'text,author,deleted';
type StoryComment = {
  text: string | null;
  deleted: boolean;
  author: SlimRef<string> | null;
};

const MEMBER_FIELDS = 'mention_name';
type Member = { mention_name: string };

// Writes need just enough of a response to tell success from failure.
const ID_ONLY_FIELDS = 'id';
type EntityId = { id: number | null };

// `GET /stories/{id}/history` returns entries in the same shape as an action's
// `changes` (plus a timestamp), so one type covers both sources.
type StoryHistory = { changes: ChangeEntry[] };

// v4 requests use cursors; page numbers are response metadata only.
type ListEnvelope<T> = {
  entities: T[];
  current_page?: number;
  total_pages?: number;
  next_page_url?: string | null;
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

const REQUEST_TIMEOUT_MS = 15_000;

// Only these diagnostics are ever logged. Never log an Error object: fetch
// errors and provider responses can contain credentials, URLs, or user text.
class ShortcutRequestError extends Error {}

function sensitiveStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(sensitiveStrings);
  return [];
}

function safeErrorDetails(body: unknown, sensitive: string[]): Record<string, string> {
  if (!body || typeof body !== 'object') return {};
  const redactions = [...new Set(sensitive.filter(Boolean).flatMap((value) =>
    [value, encodeURIComponent(value), encodeURIComponent(value).replace(/%20/g, '+'), JSON.stringify(value).slice(1, -1)],
  ))].sort((a, b) => b.length - a.length);
  const details: Record<string, string> = {};
  for (const key of ['tag', 'error', 'message', 'error_description']) {
    const raw = (body as Record<string, unknown>)[key];
    if (typeof raw !== 'string') continue;
    // Strip URLs before replacing a redirect URI prefix, otherwise its query
    // string could survive without the URL prefix that identifies it.
    let value = raw.replace(/https?:\/\/\S+/gi, '[redacted URL]');
    for (const secret of redactions) value = value.split(secret).join('[redacted]');
    details[key] = value.replace(/Bearer\s+\S+/gi, '[redacted]')
      .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500);
  }
  return details;
}

async function request(url: string, init: RequestInit, sensitive: string[]): Promise<Response> {
  const endpoint = new URL(url);
  const diagnostics = { method: init.method ?? 'GET', path: endpoint.pathname };
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    console.error('Shortcut request failed', { ...diagnostics, message: 'Network request failed or timed out' });
    throw new ShortcutRequestError('Network request failed or timed out');
  }
  if (!res.ok) {
    let body: unknown;
    try { body = await res.clone().json(); } catch { /* No raw HTML/text logging. */ }
    console.error('Shortcut request rejected', {
      ...safeErrorDetails(body, [...sensitive, ...[...endpoint.searchParams].filter(([key]) => key !== 'fields' && key !== 'limit').map(([, value]) => value)]),
      ...diagnostics, status: res.status,
    });
  }
  return res;
}

async function responseJson<T>(res: Response): Promise<T> {
  try { return await res.json() as T; } catch {
    throw new ShortcutRequestError('Response body could not be read as JSON');
  }
}

function grantedScopes(data: { scope?: unknown }, fallback?: string[]): string[] | undefined {
  return typeof data.scope === 'string' ? [...new Set(data.scope.trim().split(/\s+/).filter(Boolean))] : fallback;
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
  const res = await request(`${shortcutApiBase(s.env)}/oauth-authorization-code-flow/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: s.creds.refreshToken,
      client_id: s.env.CLIENT_ID,
      client_secret: s.env.CLIENT_SECRET,
    }),
  }, [s.env.CLIENT_SECRET, s.env.CLIENT_ID, s.creds.token, s.creds.refreshToken]);

  if (!res.ok) {
    return null;
  }

  const data = await responseJson<{
    access_token: string;
    refresh_token: string;
    access_token_expires_at: string;
    scope?: string;
  }>(res);

  const updated: WorkspaceCredentials = {
    token: data.access_token,
    slug: s.creds.slug,
    refreshToken: data.refresh_token,
    expiresAt: data.access_token_expires_at,
    memberId: s.creds.memberId, // preserved from the original OAuth flow
    scopes: grantedScopes(data, s.creds.scopes),
  };

  await storeCredentials(s.kv, s.workspaceId, updated);
  s.creds = updated;
  console.log('Guardian OAuth refreshed', { workspaceId: s.workspaceId, scopes: updated.scopes ?? 'unknown' });
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
  const sensitive = [s.env.CLIENT_SECRET, s.env.CLIENT_ID, s.creds.token, s.creds.refreshToken, ...sensitiveStrings(body)];
  if (isExpiringSoon(s.creds) && !(await refreshCredentials(s))) {
    throw new ShortcutRequestError('Token refresh failed');
  }

  const url = `${shortcutApiBase(s.env)}/api/v4/${encodeURIComponent(s.creds.slug)}${path}`;
  const init = (): RequestInit => ({
    method,
    headers: {
      Authorization: `Bearer ${s.creds.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const send = () => request(url, init(), [...sensitive, s.creds.token, s.creds.refreshToken]);
  let res = await send();

  // The token can expire between the check above and the call itself.
  if (res.status === 401) {
    if (!(await refreshCredentials(s))) return res;
    res = await send();
  }
  return res;
}

async function apiJson<T>(s: Session, method: string, path: string, body?: unknown): Promise<T | null> {
  const res = await apiFetch(s, method, path, body);
  if (!res.ok) {
    return null;
  }
  const data = await responseJson<T | { entity: T | null }>(res);
  // Detail and write responses use { entity }; list responses use { entities }.
  return data && typeof data === 'object' && 'entity' in data ? data.entity : data as T;
}

/** Walks every page of a v4 list endpoint. */
async function listAll<T>(s: Session, path: string): Promise<T[]> {
  const out: T[] = [];
  const prefix = `/api/v4/${encodeURIComponent(s.creds.slug)}`;
  const endpoint = new URL(`${shortcutApiBase(s.env)}${prefix}${path}`);
  const fields = endpoint.searchParams.get('fields');
  const seen = new Set<string>();
  let nextPath = `${path}${path.includes('?') ? '&' : '?'}limit=100`;
  for (let page = 1; ; page += 1) {
    const envelope = await apiJson<ListEnvelope<T>>(s, 'GET', nextPath);
    if (!envelope || !Array.isArray(envelope.entities)) {
      throw new ShortcutRequestError('List lookup failed or returned an invalid page');
    }
    const { current_page: current, total_pages: total, next_page_url: next } = envelope;
    if ((current !== undefined || total !== undefined) &&
      (!Number.isInteger(current) || !Number.isInteger(total) || current !== page || total! < 0 || current! > Math.max(1, total!))) {
      throw new ShortcutRequestError('List returned invalid pagination metadata');
    }
    out.push(...envelope.entities);
    if (next === undefined || next === null || next === '') {
      if (current !== undefined && total !== undefined && current < total) {
        throw new ShortcutRequestError('List response is missing its next page');
      }
      return out;
    }
    if (typeof next !== 'string' || page >= 10_000 || (current !== undefined && total !== undefined && current >= total)) {
      throw new ShortcutRequestError('List returned inconsistent pagination');
    }
    let url: URL;
    try { url = new URL(next, endpoint); } catch {
      throw new ShortcutRequestError('List returned an invalid next-page URL');
    }
    const cursor = url.searchParams.get('cursor');
    if (url.origin !== endpoint.origin || url.pathname !== endpoint.pathname || url.username || url.password || url.hash ||
      !cursor || url.searchParams.getAll('cursor').length !== 1 || url.searchParams.getAll('fields').length > 1 ||
      [...url.searchParams.keys()].some((key) => key !== 'cursor' && key !== 'fields') ||
      (url.searchParams.has('fields') && url.searchParams.get('fields') !== fields) || seen.has(cursor)) {
      throw new ShortcutRequestError('List returned an unsafe or repeated next-page URL');
    }
    seen.add(cursor);
    if (fields !== null) url.searchParams.set('fields', fields);
    nextPath = url.pathname.slice(prefix.length) + url.search;
  }
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
  // Old versions could cache a partial list after a later page failed.
  const cacheKey = `started-states:v2:${s.workspaceId}`;
  const cached = await s.kv.get(cacheKey);
  if (cached) return new Set(JSON.parse(cached) as number[]);

  const states = await listAll<WorkflowState>(s, `/workflow-states?fields=${WORKFLOW_STATE_FIELDS}`);
  // Don't cache a failed lookup as "no started states" — that would silently
  // disable the agent for an hour.
  if (states.length === 0) return new Set();

  const ids = states.filter((state) => state.type === 'started').map((state) => state.id);
  await s.kv.put(cacheKey, JSON.stringify(ids), { expirationTtl: STARTED_STATES_TTL_SECONDS });
  return new Set(ids);
}

/** True if this agent has already warned on the story. */
async function alreadyWarned(s: Session, storyId: number): Promise<boolean> {
  const comments = await listAll<StoryComment>(
    s,
    `/stories/${storyId}/comments?fields=${COMMENT_FIELDS}`,
  );
  return comments.some(
    (comment) =>
      !comment.deleted &&
      comment.author?.id === s.creds.memberId &&
      (comment.text ?? '').includes(WARNING_MARKER),
  );
}

/** The id carried by a slim ref, or null for scalars and missing values. */
function refId(value: ChangeValue | undefined): number | null {
  return typeof value === 'object' && typeof value.id === 'number' ? value.id : null;
}

/**
 * True if the update could have put the story in breach of the rule.
 *
 * Only a move or a team change can, and the delivery's `changes` says which
 * attributes the update touched — so everything else exits before touching
 * the API. When the key is absent the diff was unavailable for this delivery,
 * and the story has to be checked the slow way.
 */
function couldBreachRule(action: ObserverAction): boolean {
  if (!action.changes) return true;
  return action.changes.some(
    (change) => change.attribute === 'workflow_state' || change.attribute === 'team',
  );
}

/**
 * The state the story was in before it landed in `currentStateId`.
 *
 * The delivery's own `workflow_state` change entry is the first choice. Without
 * one — `changes` absent, or the update didn't move the story — the move is
 * reconstructed from story history, which returns entries in the same shape.
 *
 * Either way the entry is only trusted when what it added matches where the
 * story is now. The story is re-read at handling time and can have moved again
 * since the delivery was queued; an entry describing some other move would
 * send it somewhere it never was.
 */
async function previousWorkflowStateId(
  s: Session,
  action: ObserverAction,
  storyId: number,
  currentStateId: number,
): Promise<number | null> {
  const isMove = (change: ChangeEntry) => change.attribute === 'workflow_state';

  let latest = action.changes?.find(isMove);
  if (!latest) {
    const history = await apiJson<StoryHistory>(
      s,
      'GET',
      `/stories/${storyId}/history?fields=workflow_state&limit=1`,
    );
    latest = history?.changes?.find(isMove);
  }

  if (!latest || refId(latest.adds[0]) !== currentStateId) return null;
  return refId(latest.removes[0]);
}

// The display name comes straight from the delivery and ends up in a comment
// Guardian authors, so it is reduced to plain words before use: no markdown,
// no @-mentions of someone else, no runaway length.
function safeDisplayName(name: unknown): string {
  const cleaned = typeof name === 'string'
    ? name.replace(/[^\p{L}\p{N}.'_-]+/gu, ' ').trim().slice(0, 80)
    : '';
  return cleaned || 'Someone';
}

async function resolveActorMention(s: Session, actor: ObserverActor): Promise<string> {
  if (!actor.member_id) return safeDisplayName(actor.displayable_name);
  const member = await apiJson<Member>(
    s,
    'GET',
    `/members/${encodeURIComponent(actor.member_id)}?fields=${MEMBER_FIELDS}`,
  );
  // Falling back to the display name keeps the comment readable even though it
  // won't render as a real mention.
  return member?.mention_name ? `@${member.mention_name}` : safeDisplayName(actor.displayable_name);
}

/**
 * Warn and revert if the story is sitting in a started state with no team.
 * Safe to call for any updated story — every guard exits quietly.
 *
 * The delivery says what changed, but the story is still re-read for where it
 * is *now*: deliveries are handled asynchronously, and the story may have
 * gained a team or moved again since this one was queued.
 */
async function guardStory(s: Session, action: ObserverAction, actorMention: () => Promise<string>) {
  const storyId = Number(action.id);
  const story = await apiJson<Story>(s, 'GET', `/stories/${storyId}?fields=${STORY_FIELDS}`);
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

  const previousStateId = await previousWorkflowStateId(s, action, storyId, currentStateId);

  const posted = await apiJson<EntityId>(
    s,
    'POST',
    `/stories/${storyId}/comments?fields=${ID_ONLY_FIELDS}`,
    { text: warningText(await actorMention()) },
  );
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

  const reverted = await apiJson<EntityId>(
    s,
    'PATCH',
    `/stories/${storyId}?fields=${ID_ONLY_FIELDS}`,
    { workflow_state_id: previousStateId },
  );
  console.log('Guardian story warned', { storyId, previousStateId, reverted: !!reverted });
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

async function verifySignature(secret: string, body: Uint8Array, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, hexToBytes(signature), body);
}

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

app.use('/oauth/callback', async (c, next) => {
  if (!configured(c.env)) return c.json({ error: 'Configure the worker secrets first' }, 503);
  await next();
});
app.use('/webhook', async (c, next) => {
  if (!configured(c.env)) return c.json({ error: 'Configure the worker secrets first' }, 503);
  await next();
});

/** OAuth callback — exchanges the code for tokens and stores them per workspace. */
app.get('/oauth/callback', async (c) => {
  const error = c.req.query('error');
  if (error) {
    console.error('Guardian OAuth denied', { message: 'Authorization was not granted' });
    return c.text('Authorization failed. Please close this tab and try connecting again.', 400);
  }

  const code = c.req.query('code');
  if (!code) return c.text('Missing code', 400);

  try {
    const res = await request(`${shortcutApiBase(c.env)}/oauth-authorization-code-flow/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: c.env.CLIENT_ID,
        client_secret: c.env.CLIENT_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: c.env.REDIRECT_URI,
      }),
    }, [code, c.req.query('state') ?? '', c.env.CLIENT_ID, c.env.CLIENT_SECRET, c.env.REDIRECT_URI]);

    if (!res.ok) {
      return c.text('Token exchange failed. Check worker logs.', 500);
    }

    const data = await responseJson<{
      access_token: string;
      refresh_token: string;
      access_token_expires_at: string;
      permission_id: string;
      workspace2_id: string;
      workspace2_slug: string;
      scope?: string;
    }>(res);

    const scopes = grantedScopes(data);

    await storeCredentials(c.env.TOKENS, data.workspace2_id, {
      token: data.access_token,
      slug: data.workspace2_slug,
      refreshToken: data.refresh_token,
      expiresAt: data.access_token_expires_at,
      memberId: data.permission_id ?? '',
      scopes,
    });

    console.log('Guardian OAuth connected', { workspaceId: data.workspace2_id, slug: data.workspace2_slug, scopes: scopes ?? 'unknown' });
    return c.html(
      `<h2>✅ Connected!</h2>
       <p>Your workspace is now guarded.</p>
       <p>You can close this tab.</p>`,
    );
  } catch (err) {
    console.error('Guardian OAuth failed', { message: err instanceof ShortcutRequestError ? err.message : 'Could not connect workspace' });
    return c.text('Token exchange failed. Check worker logs.', 500);
  }
});

/**
 * Observer webhook — verifies the signature, then checks every updated story
 * off the request path so Shortcut isn't waiting on the Shortcut API.
 */
app.post('/webhook', async (c) => {
  const rawBody = await readBody(c.req.raw);
  if (rawBody === null) return c.json({ error: 'Payload too large' }, 413);
  const signature = c.req.header('Payload-Signature') ?? '';

  if (!(await verifySignature(c.env.WEBHOOK_SECRET, rawBody, signature))) {
    console.error('Invalid webhook signature');
    return c.json({ error: 'Invalid signature' }, 401);
  }

  let payload: ObserverPayload & { type?: string };
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  // Validation pings carry no workspace.
  if (payload.type === 'validation') return c.json({ ok: true });
  if (!Array.isArray(payload.actions)) return c.json({ ok: true });

  const workspaceId = payload.workspace2?.id;
  if (typeof workspaceId !== 'string' || !workspaceId) return c.json({ error: 'Missing workspace' }, 400);
  const creds = await getCredentials(c.env.TOKENS, workspaceId);
  if (!creds) {
    console.warn(`No credentials for workspace ${workspaceId}`);
    return c.json({ ok: true });
  }

  // The comment and the revert both come back as observer deliveries. Ignoring
  // our own edits is the first line of defence against reacting to ourselves;
  // the already-warned check is the second.
  if (payload.actor?.member_id && payload.actor.member_id === creds.memberId) {
    return c.json({ ok: true });
  }

  // Most updates are settled here, from the payload alone: one that touched
  // neither the workflow state nor the team can't have broken the rule.
  const updates = payload.actions.filter(
    (action) =>
      action.entity_type === 'story' && action.action === 'update' && couldBreachRule(action),
  );
  if (updates.length === 0) return c.json({ ok: true });

  const session: Session = { env: c.env, kv: c.env.TOKENS, workspaceId, creds };

  // Resolved at most once per delivery, and only if a story actually trips.
  let mention: Promise<string> | undefined;
  const actorMention = () => (mention ??= resolveActorMention(session, payload.actor));

  // Each story is checked in sequence so they share one refreshed token.
  c.executionCtx.waitUntil(
    (async () => {
      for (const action of updates) {
        try {
          await guardStory(session, action, actorMention);
        } catch (err) {
          console.error('Guardian story processing failed', {
            storyId: action.id,
            message: err instanceof ShortcutRequestError ? err.message : 'Could not process story',
          });
        }
      }
    })(),
  );

  return c.json({ ok: true });
});

// Unauthenticated, so it says nothing about which workspaces are connected.
// Connected workspaces and their scopes are in the OAuth connect/refresh logs.
app.get('/', (c) => c.json({ status: 'ok', service: 'Shortcut Guardian Agent' }));

export default app;
