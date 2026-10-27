import type { ShortcutSessionEventPayload } from '@shortcut/client/webhooks';
import {
  LINK_LABEL,
  MAX_FAILURES,
  MAX_LOOKUPS,
  applyEvent,
  backoffMs,
  baselined,
  checked,
  close,
  defer,
  devinPrompt,
  devinTag,
  dueAt,
  dueNow,
  endTurn,
  fail,
  isFinal,
  linked,
  live,
  observe,
  promptText,
  rejected,
  relayed,
  sendText,
  restarted,
  retiring,
  started,
  stopped,
  succeeded,
  type ActPhase,
  type Due,
  type Job,
  type PollPhase,
  type SessionState,
  type StopPhase,
  type Target,
} from './bridge';
import { DevinError, devinClient, type DevinClient, type DevinFailure } from './devin';
import type { Env } from './index';
import { loadCredentials, shortcutSessions, workspaceAllowed, type Outcome, type ShortcutSessions } from './shortcut';

type Save = (state: SessionState) => Promise<void>;
type Io = { shortcut: ShortcutSessions; devin: DevinClient; slug: string };

const UNEXPECTED_RETRY_MS = 60_000;
const INBOX = 'inbox:';
const DELETE_BATCH = 128;
const ENDED = ['complete', 'error', 'stale'];

const wait = (state: SessionState, job: Job, ms: number) => defer(state, job, ms, Date.now());
const strike = (state: SessionState, job: Job, count: number) => ({ ...state, failures: { ...state.failures, [job]: count } });
const besidesDeadlines = (state: SessionState) => JSON.stringify({ ...state, notBefore: null });

/** A job ran, changed nothing but a deadline, and was due again at once. */
class StalledError extends Error {
  constructor() {
    super('Devin Bridge step made no progress');
    this.name = 'StalledError';
  }
}

export class Session {
  private queue: Promise<unknown> = Promise.resolve();
  private stepping = false;
  private arrivedMidStep = false;

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

  fetch(request: Request): Promise<Response> {
    const next = this.queue.then(() => this.receive(request));
    this.queue = next.catch(() => undefined);
    return next;
  }

  // Shortcut times out a delivery after 5 s, so recording an event does no external I/O.
  private async receive(request: Request): Promise<Response> {
    const event = await request.json<ShortcutSessionEventPayload>();
    const storage = this.ctx.storage;
    // Only a session the bridge knows takes a stop from a workspace off the allowlist.
    if (!workspaceAllowed(this.env, event.workspace_id) && !(await storage.get('state'))) return Response.json({ ok: true, ignored: true });
    const duplicate = await storage.get(`event:${event.id}`);
    if (duplicate) {
      // A replay only restores a lost alarm; the jobs keep their own due times.
      if (!this.stepping && (await storage.getAlarm()) === null) await storage.setAlarm(Date.now());
      return Response.json({ ok: true, duplicate: true });
    }
    const seq = ((await storage.get<number>('seq')) ?? 0) + 1;
    await storage.put({ seq, [`event:${event.id}`]: seq, [`${INBOX}${String(seq).padStart(12, '0')}`]: event });
    this.arrivedMidStep = true;
    if (!this.stepping) await storage.setAlarm(Date.now());
    return Response.json({ ok: true });
  }

  // Never throws, so Cloudflare's own alarm retry cannot run a step twice.
  async alarm(): Promise<void> {
    this.stepping = true;
    this.arrivedMidStep = false;
    try {
      await this.step();
    } catch (error) {
      console.error('Devin Bridge step failed', { error: error instanceof Error ? error.name : typeof error, sessionId: this.ctx.id.name ?? String(this.ctx.id) });
      await this.ctx.storage.setAlarm(Date.now() + UNEXPECTED_RETRY_MS).catch(() => undefined);
    } finally {
      this.stepping = false;
    }
    if (this.arrivedMidStep) await this.ctx.storage.setAlarm(Date.now()).catch(() => undefined);
  }

  private async step(): Promise<void> {
    const storage = this.ctx.storage;
    const inbox = await storage.list<ShortcutSessionEventPayload>({ prefix: INBOX });
    let state = (await storage.get<SessionState>('state')) ?? null;
    for (const [key, event] of inbox) {
      const seq = Number(key.slice(INBOX.length));
      if (state !== null && seq <= state.applied) continue;
      const next = applyEvent(state, event);
      state = next && { ...next, applied: seq };
    }
    const save: Save = (current) => storage.put('state', current);
    if (inbox.size && state !== null) await save(state);
    const keys = [...inbox.keys()];
    for (let from = 0; from < keys.length; from += DELETE_BATCH) await storage.delete(keys.slice(from, from + DELETE_BATCH));
    if (state === null) return storage.deleteAlarm();

    const ran = await this.run(state, save);
    const due = dueAt(ran, Date.now());
    if (due === null) await storage.deleteAlarm();
    else await storage.setAlarm(due);
  }

  // Each job's side effects are saved before the next job runs, so a step
  // that dies mid-publish does not redo a Devin call. A stop's terminate and
  // retirement run before the Shortcut credentials are loaded.
  private async run(state: SessionState, save: Save): Promise<SessionState> {
    const devin = devinClient({ apiKey: this.env.DEVIN_API_KEY, orgId: this.env.DEVIN_ORG_ID, baseUrl: this.env.DEVIN_API_BASE });
    let io: Io | null | undefined;
    const connect = async (current: SessionState) => (io ??= await this.connect(current, devin));
    let current = state;
    let now = Date.now();
    for (let due = dueNow(current, now); due !== null; due = dueNow(current, now)) {
      const before = besidesDeadlines(current);
      current = await execute(current, due, devin, connect);
      // The clock the job returned on judges it, so a slow save cannot age a
      // wait. Every wait is at least MIN_WAIT_MS, so a job that is due again
      // at once after changing only a deadline is a bug. The alarm's catch
      // turns it into a logged retry in a minute instead of a spin.
      now = Date.now();
      await save(current);
      if (besidesDeadlines(current) === before && dueNow(current, now)?.effect === due.effect) throw new StalledError();
    }
    return current;
  }

  private async connect(state: SessionState, devin: DevinClient): Promise<Io | null> {
    if (!workspaceAllowed(this.env, state.workspaceId)) {
      console.warn('Devin Bridge closed a session from a workspace that is not in ALLOWED_WORKSPACE_IDS', { workspaceId: state.workspaceId, sessionId: state.shortcutSessionId });
      return null;
    }
    const credentials = await loadCredentials(this.env, state.workspaceId);
    if (!credentials) {
      console.error('Devin Bridge has no credentials for the workspace', { workspaceId: state.workspaceId, sessionId: state.shortcutSessionId });
      return null;
    }
    return { shortcut: shortcutSessions(this.env, state.workspaceId, credentials), devin, slug: credentials.slug };
  }
}

async function execute(state: SessionState, due: Due, devin: DevinClient, connect: (state: SessionState) => Promise<Io | null>): Promise<SessionState> {
  switch (due.effect) {
    case 'terminate': return guarded(state, () => terminateStop(state, due.phase, devin));
    case 'retire': return retire(state, devin);
  }
  const io = await connect(state);
  if (io === null) return close(state);
  switch (due.effect) {
    case 'publish': return publish(state, io);
    case 'link': return link(state, due.url, io);
    case 'check': return check(state, due.phase, io);
    case 'act': return guarded(state, () => perform(state, due.phase, io));
  }
}

// What a Devin failure costs. A 429 holds every Devin call until Retry-After.
// A failure the job may retry spends one of its strikes and backs the job off
// alone. Null once the budget is spent.
function held(state: SessionState, failure: DevinFailure, job: 'devin' | 'retire', retry: boolean): SessionState | null {
  if (failure.kind === 'rate_limited') return wait(state, 'devin', failure.retryAfterMs);
  const strikes = state.failures[job] + 1;
  return retry && strikes < MAX_FAILURES ? wait(strike(state, job, strikes), job, backoffMs(strikes)) : null;
}

// Devin failures of the phase's work land here. A 429 and a transient failure set a deadline; anything else ends the phase.
async function guarded(state: SessionState, run: () => Promise<SessionState>): Promise<SessionState> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof DevinError)) throw error;
    const { failure } = error;
    const waiting = held(state, failure, 'devin', failure.kind === 'transient');
    if (waiting) return waiting;
    const reset = succeeded(state, 'devin');
    if (state.phase.kind === 'stop') return stopped(retiring(reset), state.phase, null);
    if (failure.kind !== 'rejected') return fail(reset, 'Devin Bridge could not reach Devin. Reply to try again.', true);
    // Auth failures are the bridge's, not the session's, so the next reply may still reach it.
    const keep = failure.status === 401 || failure.status === 403;
    return fail(reset, `Devin rejected the request (HTTP ${failure.status}). ${keep ? 'Reply to try again.' : 'Reply to start a new Devin session.'}`, keep);
  }
}

async function publish(state: SessionState, { shortcut }: Io): Promise<SessionState> {
  const [activity, ...rest] = state.outbox;
  const outcome = await shortcut.postActivity(state.shortcutSessionId, activity);
  switch (outcome.kind) {
    case 'ok':
      return succeeded({ ...state, outbox: rest }, 'shortcut');
    case 'rejected': {
      const replacement = rejected(activity, outcome.status);
      return succeeded({ ...state, outbox: replacement ? [replacement, ...rest] : rest }, 'shortcut');
    }
    // A 409 on the ack of a reply not sent yet may be a turn Shortcut ended on
    // its own, which drops the reply, so the session is read before the reply is kept.
    case 'conflict':
      return state.phase.kind === 'relay' ? readTurn(state, shortcut, (current) => endTurn(current, 'conflict'), (current) => endTurn(current, 'ended')) : endTurn(state, 'conflict');
    case 'revoked':
      return endTurn(state, 'revoked');
    case 'closed':
      return close(state);
    case 'rate_limited':
      return wait(state, 'shortcut', outcome.retryAfterMs);
    // Replays are free and a turn Shortcut has ended answers 409, so this
    // retries at the backoff cap instead of giving up.
    case 'transient':
      return shortcutFailed(state);
  }
}

function shortcutFailed(state: SessionState): SessionState {
  const count = state.failures.shortcut + 1;
  return wait(strike(state, 'shortcut', count), 'shortcut', backoffMs(count));
}

// The phase's Devin work, and nothing else: a Shortcut call in here would lose
// its deadline and strikes when a later Devin call failed, since `guarded`
// keeps the state the job started from.
async function perform(state: SessionState, phase: ActPhase, { devin, slug }: Io): Promise<SessionState> {
  switch (phase.kind) {
    case 'start': {
      // Saved as attempted before the create goes out, so a stop or close that
      // follows resolves the tag instead of trusting that nothing exists.
      if (!phase.attempted) return { ...state, phase: { ...phase, attempted: true } };
      // Devin has no idempotency key; the tag lets a retried start adopt the
      // session an interrupted one created, so replies that arrived meanwhile
      // are relayed rather than folded into the create prompt.
      const tag = devinTag(state.shortcutSessionId, state.generation);
      const [adopted, ...duplicates] = await devin.findSessionsByTag(tag);
      const session = adopted ?? (await devin.createSession(devinPrompt(state, promptText(phase.prompt), slug), `Shortcut ${state.entity.type} ${state.entity.id}`, tag));
      const known = succeeded({ ...state, retire: [...state.retire, ...duplicates.map(live)] }, 'devin');
      return started(known, phase, { id: session.id, url: session.url }, Date.now());
    }
    case 'relay': {
      if (phase.send === null) {
        const session = await devin.getSession(phase.link.id);
        if (isFinal(session.state)) return restarted(succeeded(state, 'devin'), phase);
        const { messages } = await devin.listMessages(phase.link.id);
        return baselined(succeeded(state, 'devin'), phase, { last: messages[messages.length - 1]?.id ?? null, status: session.state });
      }
      await devin.sendMessage(phase.link.id, sendText(phase.send));
      return relayed(succeeded(state, 'devin'), phase, phase.send, Date.now());
    }
    case 'poll': {
      const session = await devin.getSession(phase.link.id);
      const { messages, complete } = await devin.listMessages(phase.link.id);
      if (!complete) console.warn('Devin Bridge read a cut-short Devin message list', { sessionId: state.shortcutSessionId, devinSessionId: phase.link.id });
      return observe(succeeded(state, 'devin'), phase, { state: session.state, url: session.url, pullRequests: session.pullRequests, messages, complete }, Date.now());
    }
  }
}

// The quiet-poll read of the Shortcut session: a turn Shortcut ended on its own stops the polling.
const check = (state: SessionState, phase: PollPhase, { shortcut }: Io) => readTurn(state, shortcut, (current) => checked(current, phase));

// A read of the Shortcut session. A session that is gone closes the bridge's
// and a turn Shortcut ended on its own ends it; `open` says what an open turn
// means to the caller. `unread` settles a read that failed; after a 409 it
// must not leave a reply that may belong to an ended turn runnable.
async function readTurn(state: SessionState, shortcut: ShortcutSessions, open: (state: SessionState) => SessionState, unread = (state: SessionState) => state): Promise<SessionState> {
  const read = await shortcut.getSession(state.shortcutSessionId);
  switch (read.kind) {
    case 'ok':
      if (read.value.closed_reason) return close(state);
      if (ENDED.includes(read.value.status)) return endTurn(state, 'ended');
      return succeeded(open(state), 'shortcut');
    case 'closed': return close(state);
    case 'revoked': return endTurn(state, 'revoked');
    case 'rate_limited': return unread(wait(state, 'shortcut', read.retryAfterMs));
    case 'transient': return unread(shortcutFailed(state));
    case 'conflict':
    case 'rejected': return open(state);
  }
}

// Best effort: the outcome carries the link anyway. A session Shortcut reports
// gone closes the bridge's, a revoked grant ends the turn, a wait is retried
// on the link's own budget, and a refusal or a spent budget gives the link up.
async function link(state: SessionState, url: string, { shortcut }: Io): Promise<SessionState> {
  const outcome = await linkDevin(shortcut, state.shortcutSessionId, url);
  switch (outcome.kind) {
    case 'ok': return succeeded(linked(state, url), 'shortcut');
    case 'closed': return close(state);
    case 'revoked': return endTurn(linked(state, url), 'revoked');
    case 'rate_limited': return wait(state, 'shortcut', outcome.retryAfterMs);
    case 'transient': {
      const count = state.failures.link + 1;
      return count < MAX_FAILURES ? wait(strike(state, 'link', count), 'link', backoffMs(count)) : linked(state, url);
    }
    default: return linked(state, url);
  }
}

async function terminateStop(state: SessionState, phase: StopPhase, devin: DevinClient): Promise<SessionState> {
  const found = await resolve(devin, phase.target);
  for (const session of found) await terminate(devin, session.id);
  const done = succeeded(state, 'devin');
  const { target } = phase;
  // Nothing under the tag yet may be read-after-write lag, so retirement looks again.
  const next = found.length === 0 && target?.kind === 'unresolved' ? wait({ ...done, retire: [...done.retire, { ...target, lookups: 1 }] }, 'retire', backoffMs(1)) : done;
  return stopped(next, phase, found[0]?.url ?? null);
}

// Sessions the bridge gave up are terminated here, one per run, on their own
// budget. A terminate Devin refuses spends that budget like an outage.
async function retire(state: SessionState, devin: DevinClient): Promise<SessionState> {
  const [target, ...rest] = state.retire;
  const done = succeeded({ ...state, retire: rest }, 'retire');
  try {
    const found = await resolve(devin, target);
    for (const session of found) await terminate(devin, session.id);
    if (found.length || target.kind === 'live') return done;
    const lookups = target.lookups + 1;
    if (lookups >= MAX_LOOKUPS) return done;
    return wait({ ...done, retire: [{ ...target, lookups }, ...rest] }, 'retire', backoffMs(lookups));
  } catch (error) {
    if (!(error instanceof DevinError)) throw error;
    const waiting = held(state, error.failure, 'retire', true);
    if (waiting) return waiting;
    console.warn('Devin Bridge gave up terminating a Devin session', { sessionId: state.shortcutSessionId, target: target.kind === 'live' ? target.id : target.tag });
    return done;
  }
}

async function resolve(devin: DevinClient, target: Target | null): Promise<{ id: string; url: string }[]> {
  if (target === null) return [];
  if (target.kind === 'live') return [target];
  return devin.findSessionsByTag(target.tag);
}

// Only a session that is already gone answers one of these.
const GONE = new Set([404, 409, 410]);
async function terminate(devin: DevinClient, id: string): Promise<void> {
  try {
    await devin.terminate(id);
  } catch (error) {
    if (!(error instanceof DevinError && error.failure.kind === 'rejected' && GONE.has(error.failure.status))) throw error;
  }
}

// The link is set with the session's current version and retried once on a 409.
async function linkDevin(shortcut: ShortcutSessions, sessionId: string, url: string): Promise<Outcome<unknown>> {
  const once = async (): Promise<Outcome<unknown>> => {
    const read = await shortcut.getSession(sessionId);
    if (read.kind !== 'ok') return read;
    const session = read.value;
    if (session.closed_reason) return { kind: 'closed' };
    const others = session.external_urls.filter((link) => link.label !== LINK_LABEL && link.url !== url).slice(0, 19);
    return shortcut.setExternalUrls(sessionId, session.version, [...others, { label: LINK_LABEL, url }]);
  };
  const first = await once();
  return first.kind === 'conflict' ? once() : first;
}
