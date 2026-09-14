import { Hono } from 'hono';
import {
  SHORTCUT_V4_BASE_URL,
  ShortcutOAuth,
  ShortcutOAuthError,
  ShortcutV4Client,
  grantedScopes,
  isShortcutV4RequestError,
  type ShortcutOAuthTokens,
  type ShortcutV4Page,
  type ShortcutWorkspaceApi,
} from '@shortcut/client/v4';
import {
  ShortcutWebhookClient,
  ShortcutWebhookError,
  isShortcutObserverPayload,
  isShortcutValidationPayload,
  type ShortcutChangeValue,
  type ShortcutObserverAction,
  type ShortcutVerifiedDelivery,
  type ShortcutWebhookActor,
} from '@shortcut/client/webhooks';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Env = {
  TOKENS: KVNamespace;
  ESTIMATE_GUARDIAN_STORIES: DurableObjectNamespace;
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

const apiBase = (env: Env) => env.SHORTCUT_API_BASE ?? SHORTCUT_V4_BASE_URL;

type WorkspaceCredentials = {
  token: string;
  slug: string;
  refreshToken: string;
  expiresAt: string; // ISO8601 — access_token_expires_at from token response
  memberId: string; // the agent's own permission_id — used to ignore its own edits
  scopes?: string[]; // absent for credentials issued before scope reporting
};

// The observer delivery itself — envelope, actions, and the per-attribute
// `changes` diff in the same shape as v4 story history — is typed and validated
// by `@shortcut/client/webhooks`.

// --- Shortcut v4 API shapes ------------------------------------------------

type SlimRef<Id = number> = { id: Id; entity_type: string; name?: string };

// Every v4 endpoint takes a `fields` query param. Unrequested fields are never
// calculated — a story rendered whole resolves its description markdown and
// every nested collection — so asking narrowly is worth doing on a hot path
// like this one, which reads a story for every move or estimate change in the
// workspace.
//
// Unknown field names are a 400, so each constant below is the exact field list
// for the type under it. Change one, change the other. The library's generated
// entity types describe whole entities; these narrow types describe what the
// responses actually carry once `fields` has trimmed them.

const STORY_FIELDS = 'estimate,workflow_state';
type Story = {
  estimate: number | null;
  workflow_state: SlimRef | null; // slim: id and name, no `type`
};

const WORKFLOW_STATE_FIELDS = 'id,type';
type WorkflowState = {
  id: number;
  type: 'unstarted' | 'started' | 'done';
};

const COMMENT_FIELDS = 'text,author,deleted,external_id';
type StoryComment = {
  text: string | null;
  deleted: boolean;
  author: SlimRef<string> | null;
  external_id?: string | null;
};

const MEMBER_FIELDS = 'mention_name';
type Member = { mention_name: string };

// Writes need just enough of a response to tell success from failure.
const ID_ONLY_FIELDS = 'id';
type EntityId = { id: number | null };

// ---------------------------------------------------------------------------
// The warning
// ---------------------------------------------------------------------------

// Recognising our own past warning is what makes this fire once per story.
// The marker is part of the visible sentence so the check needs no hidden
// markup, and it survives someone editing the rest of the comment.
const WARNING_MARKER = 'Stories need an estimate before being started!';

const warningText = (mention: string) =>
  `${mention} ${WARNING_MARKER} Please add an estimate and start again!`;

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
  deliveryId: string;
  recovery: RecoveryStore;
  // The v4 client for these credentials, built on first use. A refresh swaps
  // its token in place, so one client serves the whole session.
  client?: ShortcutV4Client;
};

type Recovery = {
  workspaceId: string;
  storyId: number;
  deliveryId: string;
  memberId: string;
  marker: string;
  currentStateId: number;
  previousStateId: number | null;
  phase: 'commenting' | 'warned' | 'finished';
  attempts: number;
  deadline: number;
  retryAt: number;
  outcome?: 'reverted' | 'superseded' | 'exhausted' | 'warned-only';
};

type RecoveryStore = {
  get(): Promise<Recovery | undefined>;
  // Store the record and its alarm in a single durable transaction.
  save(recovery: Recovery): Promise<void>;
};

const MAX_RECOVERY_ATTEMPTS = 6; // initial attempt plus five retries
const RECOVERY_WINDOW_MS = 5 * 60_000;
const recoveryDelay = (attempts: number) => 2_000 * 2 ** (attempts - 1);

async function finishRecovery(s: Session, recovery: Recovery, outcome: Recovery['outcome']) {
  recovery.phase = 'finished';
  recovery.outcome = outcome;
  await s.recovery.save(recovery);
  console.log('Estimate Guardian recovery finished', { storyId: recovery.storyId, outcome, attempts: recovery.attempts });
}

/** Continue only the warning created by this operation, never an old warning. */
async function completeRevert(s: Session, recovery: Recovery) {
  if (recovery.phase === 'commenting') {
    const comments = await listAll<StoryComment>(s, (ws) => ws.listStoryComments(recovery.storyId, { fields: COMMENT_FIELDS, limit: 100 }));
    const posted = comments.some((comment) => !comment.deleted && comment.author?.id === recovery.memberId && comment.external_id === recovery.marker);
    if (!posted) return; // POST may have failed or not yet become visible. Never POST again.
    recovery.phase = 'warned';
    await s.recovery.save(recovery);
  }
  const previousStateId = recovery.previousStateId;
  if (previousStateId === null) {
    await finishRecovery(s, recovery, 'warned-only');
    return;
  }
  // The comment/lookup can take time. Read immediately before *every* PATCH,
  // including recovery, rather than reusing the initial Story snapshot.
  const story = await apiEntity<Story>(s, (ws) => ws.getStory(recovery.storyId, { fields: STORY_FIELDS }));
  if (!story) return;
  if (Date.now() >= recovery.deadline) {
    await finishRecovery(s, recovery, 'exhausted');
    return;
  }
  if (story.estimate !== null || story.workflow_state?.id !== recovery.currentStateId || s.creds.memberId !== recovery.memberId) {
    await finishRecovery(s, recovery, 'superseded');
    return;
  }
  const reverted = await apiEntity<EntityId>(s, (ws) =>
    ws.updateStory(recovery.storyId, { workflow_state_id: previousStateId }, { fields: ID_ONLY_FIELDS }));
  if (reverted) await finishRecovery(s, recovery, 'reverted');
}

async function recoverRevert(s: Session, recovery: Recovery) {
  if (recovery.phase === 'finished') return;
  if (recovery.attempts >= MAX_RECOVERY_ATTEMPTS || Date.now() >= recovery.deadline) {
    await finishRecovery(s, recovery, 'exhausted');
    return;
  }
  // Reserve the attempt and next alarm before making any external call, so a
  // crash or network timeout cannot reset the cap or strand the operation.
  recovery.attempts++;
  recovery.retryAt = Math.min(recovery.deadline, Date.now() + recoveryDelay(recovery.attempts));
  await s.recovery.save(recovery);
  try {
    await completeRevert(s, recovery);
  } catch (error) {
    console.error('Estimate Guardian recovery attempt failed', { storyId: recovery.storyId, attempts: recovery.attempts,
      message: error instanceof ShortcutRequestError ? error.message : 'Could not recover revert' });
  }
  if (!recovery.outcome && recovery.attempts >= MAX_RECOVERY_ATTEMPTS) {
    await finishRecovery(s, recovery, 'exhausted');
  }
}

// ---------------------------------------------------------------------------
// Outgoing requests — bounded, and logged without secrets
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 15_000;

// Only these diagnostics are ever logged. Never log an Error object or a
// rejected Response: fetch errors and provider bodies can contain credentials,
// URLs, or user text.
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

/** Everything a request body carries, so a provider echoing it back is redacted. */
function bodyStrings(body: BodyInit | null | undefined): string[] {
  if (body instanceof URLSearchParams) return [...body.values()];
  if (typeof body !== 'string') return [];
  try { return sensitiveStrings(JSON.parse(body)); } catch { return [body]; }
}

/**
 * The `fetch` handed to the library. The library sets no timeout of its own,
 * so every request gets one here; it also reports each failure as method,
 * endpoint path and status only. `sensitive()` lists the strings that must
 * never reach a log — credentials and OAuth material — and the request's own
 * body and query values (cursors included) are redacted alongside them.
 */
function shortcutFetch(sensitive: () => string[]): typeof fetch {
  return async (input, init) => {
    const endpoint = new URL(input instanceof Request ? input.url : input);
    const diagnostics = { method: init?.method ?? 'GET', path: endpoint.pathname };
    let res: Response;
    try {
      // The library passes `signal: null`; spreading `init` first lets the timeout win.
      const upstream = await fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      // The library parses a clone and never reads the original body, which
      // would hold the connection open until the timeout fires. Buffer it here
      // so the response handed to the library is fully in memory.
      const bytes = await upstream.arrayBuffer();
      res = new Response(bytes.byteLength ? bytes : null,
        { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
    } catch {
      console.error('Shortcut request failed', { ...diagnostics, message: 'Network request failed or timed out' });
      throw new ShortcutRequestError('Network request failed or timed out');
    }
    if (!res.ok) {
      let body: unknown;
      try { body = await res.clone().json(); } catch { /* No raw HTML/text logging. */ }
      const query = [...endpoint.searchParams].filter(([key]) => key !== 'fields' && key !== 'limit').map(([, value]) => value);
      console.error('Shortcut request rejected', {
        ...safeErrorDetails(body, [...sensitive(), ...bodyStrings(init?.body), ...query]),
        ...diagnostics, status: res.status,
      });
    }
    return res;
  };
}

const sessionSecrets = (s: Session) => [s.env.CLIENT_SECRET, s.env.CLIENT_ID, s.creds.token, s.creds.refreshToken];

function clientFor(s: Session): ShortcutV4Client {
  return (s.client ??= new ShortcutV4Client({
    token: s.creds.token, baseUrl: apiBase(s.env), fetch: shortcutFetch(() => sessionSecrets(s)),
  }));
}

function oauthFor(env: Env, sensitive: () => string[]): ShortcutOAuth {
  return new ShortcutOAuth({
    clientId: env.CLIENT_ID, clientSecret: env.CLIENT_SECRET, redirectUri: env.REDIRECT_URI,
    baseUrl: apiBase(env), fetch: shortcutFetch(sensitive),
  });
}

/** Scopes as the token endpoint reported them. An omitted `scope` is unknown, not none. */
function reportedScopes(tokens: Pick<ShortcutOAuthTokens, 'scope'>, fallback?: string[]): string[] | undefined {
  return typeof tokens.scope === 'string' ? grantedScopes(tokens) : fallback;
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
  let tokens: ShortcutOAuthTokens;
  try {
    tokens = await oauthFor(s.env, () => sessionSecrets(s)).refreshAccessToken(s.creds.refreshToken);
  } catch (error) {
    // A rejected token request was already reported, redacted, by the fetch
    // wrapper. Its message carries provider text, so it is not repeated here.
    if (error instanceof ShortcutOAuthError) return null;
    throw error;
  }

  const updated: WorkspaceCredentials = {
    token: tokens.access_token,
    slug: s.creds.slug,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.access_token_expires_at,
    memberId: s.creds.memberId, // preserved from the original OAuth flow
    scopes: reportedScopes(tokens, s.creds.scopes),
  };

  await storeCredentials(s.kv, s.workspaceId, updated);
  s.creds = updated;
  clientFor(s).setToken(updated.token);
  console.log('Estimate Guardian OAuth refreshed', { workspaceId: s.workspaceId, scopes: updated.scopes ?? 'unknown' });
  return updated;
}

function isExpiringSoon(creds: WorkspaceCredentials): boolean {
  if (!creds.expiresAt) return false;
  return new Date(creds.expiresAt).getTime() < Date.now() + 5 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Shortcut v4 API (with auto-refresh on 401)
// ---------------------------------------------------------------------------

/**
 * Runs one call against the workspace-bound API. The token is refreshed
 * proactively near expiry, and once more if the call still comes back 401 —
 * it can expire between the check and the request. Any other rejection is
 * the library's: the `Response` for an HTTP failure, or the wrapper's
 * `ShortcutRequestError` for a network failure.
 */
async function withRefresh<T>(s: Session, call: (ws: ShortcutWorkspaceApi) => Promise<T>): Promise<T> {
  if (isExpiringSoon(s.creds) && !(await refreshCredentials(s))) {
    throw new ShortcutRequestError('Token refresh failed');
  }
  const client = clientFor(s);
  try {
    return await call(client.workspace(s.creds.slug));
  } catch (error) {
    if (!isShortcutV4RequestError(error) || error.status !== 401 || !(await refreshCredentials(s))) throw error;
    return call(client.workspace(s.creds.slug));
  }
}

/** The result of one call, or null when the API rejected it. Network failures still throw. */
async function attempt<T>(s: Session, call: (ws: ShortcutWorkspaceApi) => Promise<T>): Promise<T | null> {
  try {
    return await withRefresh(s, call);
  } catch (error) {
    if (isShortcutV4RequestError(error)) return null;
    throw error;
  }
}

/** A single-entity read or write, unwrapped from `{ entity }`, or null when it was rejected. */
async function apiEntity<T>(s: Session, call: (ws: ShortcutWorkspaceApi) => Promise<{ entity: unknown }>): Promise<T | null> {
  const wrapper = await attempt(s, call);
  return wrapper && typeof wrapper === 'object' && wrapper.entity ? (wrapper.entity as T) : null;
}

/**
 * Every entity of a list endpoint. `paginate` follows `next_page_url` cursors
 * and fails closed on a rejected page, an unsafe or repeated link, or a
 * missing one — so this never returns a partial list as if it were complete.
 */
async function listAll<T>(s: Session, list: (ws: ShortcutWorkspaceApi) => Promise<ShortcutV4Page<unknown>>): Promise<T[]> {
  const out: T[] = [];
  try {
    for await (const item of clientFor(s).paginate(withRefresh(s, list))) out.push(item as T);
  } catch (error) {
    if (error instanceof ShortcutRequestError) throw error;
    throw new ShortcutRequestError(isShortcutV4RequestError(error)
      ? 'List lookup failed'
      : 'List returned an invalid, unsafe, or incomplete page');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Estimate Guardian logic
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

  const states = await listAll<WorkflowState>(s, (ws) => ws.listWorkflowStates({ fields: WORKFLOW_STATE_FIELDS, limit: 100 }));
  // Don't cache a failed lookup as "no started states" — that would silently
  // disable the agent for an hour.
  if (states.length === 0) return new Set();

  const ids = states.filter((state) => state.type === 'started').map((state) => state.id);
  await s.kv.put(cacheKey, JSON.stringify(ids), { expirationTtl: STARTED_STATES_TTL_SECONDS });
  return new Set(ids);
}

/** True if this agent has already warned on the story. */
async function alreadyWarned(s: Session, storyId: number): Promise<boolean> {
  const comments = await listAll<StoryComment>(s, (ws) => ws.listStoryComments(storyId, { fields: COMMENT_FIELDS, limit: 100 }));
  return comments.some(
    (comment) =>
      !comment.deleted &&
      comment.author?.id === s.creds.memberId &&
      (comment.text ?? '').includes(WARNING_MARKER),
  );
}

/** The id carried by a slim ref, or null for scalars and missing values. */
function refId(value: ShortcutChangeValue | undefined): number | null {
  return typeof value === 'object' && value !== null && typeof value.id === 'number' ? value.id : null;
}

/**
 * True if the update could have put the story in breach of the rule.
 *
 * Only a move or an estimate change can, and the delivery's `changes` says which
 * attributes the update touched — so everything else exits before touching
 * the API. When the key is absent the diff was unavailable for this delivery,
 * and the story has to be checked the slow way.
 */
function couldBreachRule(action: ShortcutObserverAction): boolean {
  if (!action.changes) return true;
  return action.changes.some(
    (change) => change.attribute === 'workflow_state' || change.attribute === 'estimate',
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
  action: ShortcutObserverAction,
  storyId: number,
  currentStateId: number,
): Promise<number | null> {
  const isMove = (change: { attribute: string }) => change.attribute === 'workflow_state';

  let latest: { adds: ShortcutChangeValue[]; removes: ShortcutChangeValue[] } | undefined = action.changes?.find(isMove);
  if (!latest) {
    const history = await attempt(s, (ws) => ws.getStoryHistory(storyId, { fields: 'workflow_state', limit: 1 }));
    latest = history?.changes?.find(isMove);
  }

  if (!latest || refId(latest.adds[0]) !== currentStateId) return null;
  return refId(latest.removes[0]);
}

// The display name comes straight from the delivery and ends up in a comment
// Estimate Guardian authors, so it is reduced to plain words before use: no markdown,
// no @-mentions of someone else, no runaway length.
function safeDisplayName(name: unknown): string {
  const cleaned = typeof name === 'string'
    ? name.replace(/[^\p{L}\p{N}.'_-]+/gu, ' ').trim().slice(0, 80)
    : '';
  return cleaned || 'Someone';
}

async function resolveActorMention(s: Session, actor: ShortcutWebhookActor): Promise<string> {
  if (!actor.member_id) return safeDisplayName(actor.displayable_name);
  // Generated operations splice path parameters in as given, and this one
  // comes from the delivery, so it is encoded here.
  const memberId = encodeURIComponent(actor.member_id);
  const member = await apiEntity<Member>(s, (ws) => ws.getMember(memberId, { fields: MEMBER_FIELDS }));
  // Falling back to the display name keeps the comment readable even though it
  // won't render as a real mention.
  return member?.mention_name ? `@${member.mention_name}` : safeDisplayName(actor.displayable_name);
}

/**
 * Warn and revert if the story is sitting in a started state with no estimate.
 * Safe to call for any updated story — every guard exits quietly.
 *
 * The delivery says what changed, but the story is still re-read for where it
 * is *now*: deliveries are handled asynchronously, and the story may have
 * gained an estimate or moved again since this one was queued.
 */
async function guardStory(s: Session, action: ShortcutObserverAction, actorMention: () => Promise<string>) {
  const storyId = Number(action.id);
  const pending = await s.recovery.get();
  if (pending && pending.phase !== 'finished') {
    // A different observed move/estimate edit supersedes the original operation,
    // even if the Story has already moved back to the same state by this read.
    if (pending.deliveryId !== s.deliveryId && action.changes?.some((change) =>
      change.attribute === 'workflow_state' || change.attribute === 'estimate')) {
      await finishRecovery(s, pending, 'superseded');
      return;
    }
    await recoverRevert(s, pending);
    return;
  }
  if (pending?.deliveryId === s.deliveryId) return;
  const story = await apiEntity<Story>(s, (ws) => ws.getStory(storyId, { fields: STORY_FIELDS }));
  if (!story) return;

  if (story.estimate !== null) return; // has an estimate — nothing to enforce

  const currentStateId = story.workflow_state?.id;
  if (!currentStateId) return;

  const started = await startedStateIds(s);
  if (!started.has(currentStateId)) return; // not a started state

  if (await alreadyWarned(s, storyId)) {
    console.log(`Story ${storyId} already warned, leaving it alone`);
    return;
  }

  const previousStateId = await previousWorkflowStateId(s, action, storyId, currentStateId);
  const text = warningText(await actorMention());
  const recovery: Recovery = {
    workspaceId: s.workspaceId, storyId, deliveryId: s.deliveryId, memberId: s.creds.memberId,
    marker: `estimate-guardian:${crypto.randomUUID()}`, currentStateId, previousStateId,
    phase: 'commenting', attempts: 1, deadline: Date.now() + RECOVERY_WINDOW_MS,
    retryAt: Date.now() + recoveryDelay(1),
  };
  await s.recovery.save(recovery);
  try {
    const posted = await apiEntity<EntityId>(s, (ws) =>
      ws.createStoryComment(storyId, { text, external_id: recovery.marker }, { fields: ID_ONLY_FIELDS }));
    if (!posted) {
      console.error(`Could not confirm comment on story ${storyId}, skipping revert`);
      return;
    }
    recovery.phase = 'warned';
    await s.recovery.save(recovery);
    await completeRevert(s, recovery);
  } catch (error) {
    console.error('Estimate Guardian initial attempt failed', { storyId,
      message: error instanceof ShortcutRequestError ? error.message : 'Could not complete warning and revert' });
  }
}

/** One coordinator per workspace/Story. Credentials remain in the existing KV. */
export class EstimateGuardianStory {
  private tail: Promise<unknown> = Promise.resolve();
  private recovery: RecoveryStore;

  constructor(private state: DurableObjectState, private env: Env) {
    this.recovery = {
      get: () => this.state.storage.get<Recovery>('recovery'),
      save: (record) => this.state.storage.transaction(async (tx) => {
        await tx.put('recovery', record);
        if (record.phase === 'finished') await tx.deleteAlarm();
        else await tx.setAlarm(record.retryAt);
      }),
    };
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const work = this.tail.then(run);
    this.tail = work.catch(() => {});
    return work;
  }

  fetch(request: Request): Promise<Response> {
    return this.serialize(async () => {
      try {
        const { workspaceId, deliveryId, action, actor } = await request.json() as {
          workspaceId: string; deliveryId: string; action: ShortcutObserverAction; actor: ShortcutWebhookActor;
        };
        const creds = await getCredentials(this.env.TOKENS, workspaceId);
        if (!creds || actor?.member_id === creds.memberId) return Response.json({ ok: true });
        const session: Session = { env: this.env, kv: this.env.TOKENS, workspaceId, creds, deliveryId, recovery: this.recovery };
        await guardStory(session, action, () => resolveActorMention(session, actor));
        return Response.json({ ok: true });
      } catch (error) {
        console.error('Estimate Guardian story processing failed', {
          message: error instanceof ShortcutRequestError ? error.message : 'Could not process story',
        });
        return Response.json({ error: 'Could not process story' }, { status: 503 });
      }
    });
  }

  alarm(): Promise<void> {
    return this.serialize(async () => {
      const record = await this.recovery.get();
      if (!record || record.phase === 'finished') return;
      try {
        const creds = await getCredentials(this.env.TOKENS, record.workspaceId);
        if (!creds) {
          // No authorization means no retries or API writes.
          record.phase = 'finished';
          record.outcome = 'exhausted';
          await this.recovery.save(record);
          console.warn('Estimate Guardian recovery stopped: workspace credentials unavailable');
          return;
        }
        await recoverRevert({ env: this.env, kv: this.env.TOKENS, workspaceId: record.workspaceId,
          deliveryId: record.deliveryId, creds, recovery: this.recovery }, record);
      } catch {
        // Storage failures can use Cloudflare's bounded alarm redelivery. No
        // raw exception contents are logged and reserved attempts stay saved.
        console.error('Estimate Guardian recovery storage unavailable');
        throw new Error('Estimate Guardian recovery storage unavailable');
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Webhook body
// ---------------------------------------------------------------------------

// Deliveries are small; anything larger is not a delivery. Reading with a cap
// keeps an oversized body from being buffered and hashed in full — the
// library only checks the size of bytes it is handed, so the cap lives here.
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
    console.error('Estimate Guardian OAuth denied', { message: 'Authorization was not granted' });
    return c.text('Authorization failed. Please close this tab and try connecting again.', 400);
  }

  const code = c.req.query('code');
  if (!code) return c.text('Missing code', 400);
  const state = c.req.query('state') ?? '';

  try {
    const oauth = oauthFor(c.env, () => [code, state, c.env.CLIENT_ID, c.env.CLIENT_SECRET, c.env.REDIRECT_URI]);
    const tokens = await oauth.exchangeAuthorizationCode(code);
    const scopes = reportedScopes(tokens);

    await storeCredentials(c.env.TOKENS, tokens.workspace2_id, {
      token: tokens.access_token,
      slug: tokens.workspace2_slug,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.access_token_expires_at,
      memberId: tokens.permission_id ?? '',
      scopes,
    });

    console.log('Estimate Guardian OAuth connected', { workspaceId: tokens.workspace2_id, slug: tokens.workspace2_slug, scopes: scopes ?? 'unknown' });
    return c.html(
      `<h2>✅ Connected!</h2>
       <p>Your workspace is now guarded.</p>
       <p>You can close this tab.</p>`,
    );
  } catch (err) {
    // A rejected exchange was already reported, redacted, by the fetch wrapper.
    // The code, state, and the provider's own text stay out of the logs.
    console.error('Estimate Guardian OAuth failed', {
      message: err instanceof ShortcutOAuthError ? 'Token exchange rejected'
        : err instanceof ShortcutRequestError ? err.message : 'Could not connect workspace',
    });
    return c.text('Token exchange failed. Check worker logs.', 500);
  }
});

/**
 * Observer webhook — verifies the signature, then checks every updated story
 * in a per-Story coordinator with durable partial-success recovery.
 */
app.post('/webhook', async (c) => {
  const rawBody = await readBody(c.req.raw);
  if (rawBody === null) return c.json({ error: 'Payload too large' }, 413);

  // Signature first, then the envelope: a delivery missing its id, workspace,
  // actor, or a well-formed action never gets past here.
  let delivery: ShortcutVerifiedDelivery;
  try {
    delivery = await new ShortcutWebhookClient(c.env.WEBHOOK_SECRET).verifyBody(rawBody, c.req.header('Payload-Signature'));
  } catch (error) {
    if (!(error instanceof ShortcutWebhookError)) throw error;
    if (error.status === 413) return c.json({ error: 'Payload too large' }, 413);
    if (error.status === 401) {
      console.error('Invalid webhook signature');
      return c.json({ error: 'Invalid signature' }, 401);
    }
    return c.json({ error: 'Invalid payload' }, 400);
  }
  const { payload } = delivery;

  // Validation pings carry no workspace, and interaction deliveries are not
  // subscribed: both are acknowledged and otherwise ignored.
  if (isShortcutValidationPayload(payload) || !isShortcutObserverPayload(payload)) return c.json({ ok: true });

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

  // Most updates are settled here, from the payload alone: one that touched
  // neither the workflow state nor the estimate can't have broken the rule.
  const updates = payload.actions.filter(
    (action) =>
      action.entity_type === 'story' && action.action === 'update' && couldBreachRule(action),
  );
  if (updates.length === 0) return c.json({ ok: true });

  // Await the coordinator: any in-flight warning/revert and its recovery alarm
  // must be durable before Shortcut sees success. Duplicate calls serialize.
  for (const action of updates) {
    if (!Number.isSafeInteger(Number(action.id)) || Number(action.id) <= 0) return c.json({ error: 'Invalid story id' }, 400);
    const id = c.env.ESTIMATE_GUARDIAN_STORIES.idFromName(JSON.stringify([workspaceId, Number(action.id)]));
    const response = await c.env.ESTIMATE_GUARDIAN_STORIES.get(id).fetch('https://estimate-guardian.internal/guard', {
      method: 'POST', body: JSON.stringify({ workspaceId, deliveryId: payload.id, action, actor: payload.actor }),
    });
    if (!response.ok) return c.json({ error: 'Could not process story' }, 503);
  }

  return c.json({ ok: true });
});

// Unauthenticated, so it says nothing about which workspaces are connected.
// Connected workspaces and their scopes are in the OAuth connect/refresh logs.
app.get('/', (c) => c.json({ status: 'ok', service: 'Shortcut Estimate Guardian Agent' }));

export default app;
