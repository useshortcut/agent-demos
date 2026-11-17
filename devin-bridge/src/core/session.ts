import type { ShortcutSessionEventPayload } from '@shortcut/client/webhooks';
import {
  MAX_FAILURES,
  MAX_LOOKUPS,
  abandoned,
  answered,
  applyEvent,
  attempting,
  backoffMs,
  checked,
  close,
  conversationKey,
  defer,
  dueAt,
  dueNow,
  endTurn,
  fail,
  linked,
  live,
  observed,
  openingText,
  prepared,
  published,
  readsFirst,
  rejected,
  relayed,
  restarted,
  restored,
  retiring,
  started,
  stopped,
  succeeded,
  type ActPhase,
  type Due,
  type FirstPortState,
  type Job,
  type PollPhase,
  type SessionState,
  type StopPhase,
} from './bridge';
import { connect as backendOf, identity, type BackendEnv, type Memo } from '../backend';
import * as adapter from '../backend';
import { BackendError, type Backend, type BackendFailure, type BackendModule, type Halted } from './port';
import type { Env } from './app';
import { loadCredentials, shortcutSessions, workspaceAllowed, type Outcome, type ShortcutSessions } from './shortcut';

type Save = (state: SessionState) => Promise<void>;
type Io = { shortcut: ShortcutSessions; backend: Backend<Memo>; slug: string };

const UNEXPECTED_RETRY_MS = 60_000;
const INBOX = 'inbox:';
const DELETE_BATCH = 128;
// A stale session is not ended. Shortcut takes the next activity and makes it active again.
const ENDED = ['complete', 'error'];

const wait = (state: SessionState, job: Job, ms: number) => defer(state, job, ms, Date.now());
const strike = (state: SessionState, job: Job, count: number) => ({ ...state, failures: { ...state.failures, [job]: count } });
const besidesDeadlines = (state: SessionState) => JSON.stringify({ ...state, notBefore: null });

/** A job ran, changed nothing but a deadline, and was due again at once. */
class StalledError extends Error {
  constructor() {
    super(`${identity.title} step made no progress`);
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
      console.error(`${identity.title} step failed`, { error: error instanceof Error ? error.name : typeof error, sessionId: this.ctx.id.name ?? String(this.ctx.id) });
      await this.ctx.storage.setAlarm(Date.now() + UNEXPECTED_RETRY_MS).catch(() => undefined);
    } finally {
      this.stepping = false;
    }
    if (this.arrivedMidStep) await this.ctx.storage.setAlarm(Date.now()).catch(() => undefined);
  }

  private async step(): Promise<void> {
    const storage = this.ctx.storage;
    const save: Save = (current) => storage.put('state', current);
    const state = await this.absorb(await load(storage, this.ctx.id.name ?? String(this.ctx.id)), save);
    if (state === null) return storage.deleteAlarm();

    const ran = await this.run(state, save);
    const due = dueAt(ran, Date.now());
    if (due === null) await storage.deleteAlarm();
    else await storage.setAlarm(due);
  }

  // Applies the events in the inbox to the state, saves it, and empties the
  // inbox. An event recorded after this read sets `arrivedMidStep` again.
  private absorb(state: SessionState, save: Save): Promise<SessionState>;
  private absorb(state: SessionState | null, save: Save): Promise<SessionState | null>;
  private async absorb(held: SessionState | null, save: Save): Promise<SessionState | null> {
    const storage = this.ctx.storage;
    this.arrivedMidStep = false;
    const inbox = await storage.list<ShortcutSessionEventPayload>({ prefix: INBOX });
    let state = held;
    for (const [key, event] of inbox) {
      const seq = Number(key.slice(INBOX.length));
      if (state !== null && seq <= state.applied) continue;
      const next = applyEvent(state, event);
      state = next && { ...next, applied: seq };
    }
    if (inbox.size && state !== null) await save(state);
    const keys = [...inbox.keys()];
    for (let from = 0; from < keys.length; from += DELETE_BATCH) await storage.delete(keys.slice(from, from + DELETE_BATCH));
    return state;
  }

  // Each job's side effects are saved before the next job runs, so a step
  // that dies mid-publish does not redo a backend call. A stop's halt and
  // retirement run before the Shortcut credentials are loaded.
  //
  // Shortcut can deliver an event while a job waits on the backend, on
  // Shortcut, or on the Workspace object for the credentials. The inbox is
  // read again after each of those waits and the plan is made from what it
  // held. So an event the bridge acknowledged before a job's backend call
  // goes out is applied before that call, and a stop cancels what the step
  // was about to send. One job makes two calls: a send that carries only the
  // context goes out right after the read that allows it. A stop cancels no
  // context, so that send has nothing to lose to an event it has not read.
  private async run(state: SessionState, save: Save): Promise<SessionState> {
    const backend = backendOf(this.env);
    let io: Io | null | undefined;
    let current = state;
    let now = Date.now();
    for (let due = dueNow(current, now); due !== null; due = dueNow(current, now)) {
      if (io === undefined && usesShortcut(due)) {
        io = await this.connect(current, backend);
      } else {
        const before = besidesDeadlines(current);
        current = await execute(current, due, backend, io ?? null);
        // The clock the job returned on judges it, so a slow save cannot age a
        // wait. Every wait is at least MIN_WAIT_MS, so a job that is due again
        // at once after changing only a deadline is a bug. The alarm's catch
        // turns it into a logged retry in a minute instead of a spin.
        now = Date.now();
        await save(current);
        if (besidesDeadlines(current) === before && dueNow(current, now)?.effect === due.effect) throw new StalledError();
      }
      current = await this.absorb(current, save);
    }
    return current;
  }

  private async connect(state: SessionState, backend: Backend<Memo>): Promise<Io | null> {
    if (!workspaceAllowed(this.env, state.workspaceId)) {
      console.warn(`${identity.title} closed a session from a workspace that is not in ALLOWED_WORKSPACE_IDS`, { workspaceId: state.workspaceId, sessionId: state.shortcutSessionId });
      return null;
    }
    const credentials = await loadCredentials(this.env, state.workspaceId);
    if (!credentials) {
      console.error(`${identity.title} has no credentials for the workspace`, { workspaceId: state.workspaceId, sessionId: state.shortcutSessionId });
      return null;
    }
    return { shortcut: shortcutSessions(this.env, state.workspaceId, credentials), backend, slug: credentials.slug };
  }
}

const { upgradeState }: BackendModule<Memo, BackendEnv> = adapter;

// A state of an earlier shape is saved in today's by the step's next save.
async function load(storage: DurableObjectStorage, sessionId: string): Promise<SessionState | null> {
  const stored = await storage.get<SessionState | FirstPortState | { v?: undefined }>('state');
  if (stored === undefined) return null;
  const known = stored.v === 2 || stored.v === 3 ? stored : upgradeState?.(stored) ?? null;
  if (known !== null) return restored(known);
  console.warn(`${identity.title} dropped a stored session state of an older shape`, { sessionId });
  await storage.delete('state');
  return null;
}

/** Every job but a stop's halt and retirement, which need only the backend. */
const usesShortcut = (due: Due) => due.effect !== 'halt' && due.effect !== 'retire';

// `io` is null when the workspace has no credentials or is off the allowlist. A job that uses Shortcut then closes the session.
async function execute(state: SessionState, due: Due, backend: Backend<Memo>, io: Io | null): Promise<SessionState> {
  switch (due.effect) {
    case 'halt': return guarded(state, () => haltStop(state, due.phase, backend));
    case 'retire': return retire(state, backend);
  }
  if (io === null) return close(state);
  switch (due.effect) {
    case 'publish': return publish(state, io);
    case 'link': return link(state, due.url, io);
    case 'check': return check(state, due.phase, io);
    case 'act': return guarded(state, () => perform(state, due.phase, io));
  }
}

// What a backend failure costs. A hold stops every backend call until it passes.
// A failure the job may retry spends one of its strikes and backs the job off
// alone. Null once the budget is spent.
function held(state: SessionState, failure: BackendFailure, job: 'backend' | 'retire', retry: boolean): SessionState | null {
  if (failure.kind === 'hold') return wait(state, 'backend', failure.retryAfterMs);
  const strikes = state.failures[job] + 1;
  return retry && strikes < MAX_FAILURES ? wait(strike(state, job, strikes), job, backoffMs(strikes)) : null;
}

// Backend failures of the phase's work land here. A hold and a transient failure set a deadline; anything else ends the phase.
async function guarded(state: SessionState, run: () => Promise<SessionState>): Promise<SessionState> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof BackendError)) throw error;
    const { failure } = error;
    const waiting = held(state, failure, 'backend', failure.kind === 'transient');
    if (waiting) return waiting;
    const reset = succeeded(state, 'backend');
    if (state.phase.kind === 'stop') return stopped(retiring(reset), state.phase, { kind: 'ended', url: null });
    const reading = state.phase.kind === 'relay' ? abandoned(reset, state.phase, Date.now()) : null;
    if (reading) return reading;
    if (failure.kind !== 'rejected') return fail(reset, `${identity.title} could not reach ${identity.name}. Reply to try again.`, true);
    // Auth failures are the bridge's, not the session's, so the next reply may still reach it.
    const keep = failure.status === 401 || failure.status === 403;
    return fail(reset, `${identity.name} rejected the request (HTTP ${failure.status}). ${keep ? 'Reply to try again.' : `Reply to start a new ${identity.name} session.`}`, keep);
  }
}

async function publish(state: SessionState, { shortcut }: Io): Promise<SessionState> {
  const [activity, ...rest] = state.outbox;
  const outcome = await shortcut.postActivity(state.shortcutSessionId, activity);
  switch (outcome.kind) {
    case 'ok':
      return succeeded(published(state), 'shortcut');
    case 'rejected': {
      const replacement = rejected(activity, outcome.status);
      return succeeded({ ...state, outbox: replacement ? [replacement, ...rest] : rest }, 'shortcut');
    }
    // A 409 on the ack of a request not sent yet, in an open or in a relay,
    // may be a turn Shortcut ended on its own, which drops the request. So the
    // session is read before the request is kept.
    case 'conflict':
      return state.phase.kind === 'start' || state.phase.kind === 'relay' ? readTurn(state, shortcut, (current) => endTurn(current, 'conflict'), (current) => endTurn(current, 'ended')) : endTurn(state, 'conflict');
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

// The phase's backend work, and nothing else: a Shortcut call in here would
// lose its deadline and strikes when a later backend call failed, since
// `guarded` keeps the state the job started from.
async function perform(state: SessionState, phase: ActPhase, { backend, slug }: Io): Promise<SessionState> {
  switch (phase.kind) {
    case 'start': {
      // Saved as attempted before the open goes out, so a stop or close that
      // follows resolves the key instead of trusting that nothing exists.
      if (!phase.attempted) return attempting(state, phase);
      // A retried open finds what an interrupted one made under the same key,
      // so replies that arrived meanwhile are relayed rather than folded into
      // the opening text.
      const opened = await backend.open({
        key: conversationKey(state.shortcutSessionId, state.generation),
        title: `Shortcut ${state.entity.type} ${state.entity.id}`,
        text: openingText(state, phase, slug),
      });
      const known = succeeded({ ...state, retire: [...state.retire, ...opened.duplicates.map(live)] }, 'backend');
      return started(known, phase, opened, Date.now());
    }
    case 'relay': {
      if (phase.send === null) {
        const ready = await backend.prepare(phase.on);
        const known = succeeded(state, 'backend');
        return ready.kind === 'gone' ? restarted(known, phase, ready.empty, Date.now()) : prepared(known, phase, ready, slug, Date.now());
      }
      const { text, key, memo } = phase.send;
      if (readsFirst(phase, phase.send)) {
        const outcome = answered(succeeded(state, 'backend'), phase, await backend.observe(phase.on), Date.now());
        if (outcome) return outcome;
      }
      const sent = await backend.send({ ...phase.on, memo }, { text, key });
      return relayed(succeeded(state, 'backend'), phase, phase.send, sent, Date.now());
    }
    case 'poll':
      return observed(succeeded(state, 'backend'), phase, await backend.observe(phase.on), Date.now());
  }
}

// The quiet-poll read of the Shortcut session: a turn Shortcut ended on its own stops the polling.
const check = (state: SessionState, phase: PollPhase, { shortcut }: Io) => readTurn(state, shortcut, (current) => checked(current, phase));

// A read of the Shortcut session. A session that is gone closes the bridge's
// and a turn Shortcut ended on its own ends it; `open` says what an open turn
// means to the caller. `unread` settles a read that failed; after a 409 it
// must not leave a request that may belong to an ended turn runnable.
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
  const outcome = await setLink(shortcut, state.shortcutSessionId, url);
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

async function haltStop(state: SessionState, phase: StopPhase, backend: Backend<Memo>): Promise<SessionState> {
  const { target } = phase;
  const halted: Halted = target ? await backend.halt(target) : { kind: 'ended', url: null };
  const done = succeeded(state, 'backend');
  // Nothing under the key yet may be read-after-write lag, so retirement looks again.
  const next = halted.kind === 'unseen' && target?.kind === 'unresolved' ? wait({ ...done, retire: [...done.retire, { ...target, lookups: 1 }] }, 'retire', backoffMs(1)) : done;
  return stopped(next, phase, halted);
}

// Conversations the bridge gave up are halted here, one per run, on their own
// budget. A halt the backend refuses spends that budget like an outage. Only
// a key that finds nothing is looked up again: a conversation the backend
// kept is halted, which is all retirement asks.
async function retire(state: SessionState, backend: Backend<Memo>): Promise<SessionState> {
  const [target, ...rest] = state.retire;
  const done = succeeded({ ...state, retire: rest }, 'retire');
  try {
    const halted = await backend.halt(target);
    if (halted.kind !== 'unseen' || target.kind === 'live') return done;
    const lookups = target.lookups + 1;
    if (lookups >= MAX_LOOKUPS) return done;
    return wait({ ...done, retire: [{ ...target, lookups }, ...rest] }, 'retire', backoffMs(lookups));
  } catch (error) {
    if (!(error instanceof BackendError)) throw error;
    const waiting = held(state, error.failure, 'retire', true);
    if (waiting) return waiting;
    console.warn(`${identity.title} gave up terminating ${identity.aSession}`, { sessionId: state.shortcutSessionId, target: target.kind === 'live' ? target.conversation.id : target.key });
    return done;
  }
}

// The link is set with the session's current version and retried once on a 409.
async function setLink(shortcut: ShortcutSessions, sessionId: string, url: string): Promise<Outcome<unknown>> {
  const once = async (): Promise<Outcome<unknown>> => {
    const read = await shortcut.getSession(sessionId);
    if (read.kind !== 'ok') return read;
    const session = read.value;
    if (session.closed_reason) return { kind: 'closed' };
    const others = session.external_urls.filter((link) => link.label !== identity.linkLabel && link.url !== url).slice(0, 19);
    return shortcut.setExternalUrls(sessionId, session.version, [...others, { label: identity.linkLabel, url }]);
  };
  const first = await once();
  return first.kind === 'conflict' ? once() : first;
}
