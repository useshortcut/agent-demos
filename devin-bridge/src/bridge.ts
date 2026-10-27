import type { ShortcutSessionEventPayload, ShortcutSessionPromptedPayload } from '@shortcut/client/webhooks';

export type Activity = {
  key: string;
  turn: number;
  content: { type: 'thought' | 'elicitation' | 'response' | 'error'; body: string };
  ephemeral?: true;
};

export type Link = { id: string; url: string };

/** A Devin session the bridge may still have to terminate: one it knows, or any a create may have made under a tag. */
export type Target = ({ kind: 'live' } & Link) | { kind: 'unresolved'; tag: string; lookups: number };

/** What Devin showed before a reply was sent. Until Devin acts on the reply, its status still describes the previous turn. */
export type Baseline = { last: string | null; status: DevinState };

/** A reply sent to Devin, with the baseline read before the send and the time the send went through. */
export type Relayed = { prompt: string; baseline: Baseline; since: number; heard: boolean };

/** A reply Devin has not received yet. Its turn orders it among the others, whatever order they arrived in. The opening request of a late `session.created` is never superseded by a newer reply. */
export type Pending = { turn: number; text: string; opening?: true };

/** What one relay sends, fixed when its baseline is read, so a retried send repeats the same text. */
export type Send = { prompt: Pending[]; late: Pending | null; baseline: Baseline };

export type Phase =
  | { kind: 'start'; prompt: Pending[]; extra: Pending[]; attempted: boolean }
  /** Until `send` is set, `prompt` is what the next baseline read fixes. After, it waits for the relay that follows. */
  | { kind: 'relay'; link: Link; prompt: Pending[]; send: Send | null }
  /** `check` asks for a Shortcut read of the session with the next poll. `asked` is the key suffix of the posted elicitation. */
  | { kind: 'poll'; link: Link; at: number; delayMs: number; check: boolean; posted: string | null; asked: string | null; relayed: Relayed | null }
  | { kind: 'stop'; target: Target | null; then: Pending[] }
  | { kind: 'idle'; link: Link | null }
  | { kind: 'closed' };

export type StartPhase = Extract<Phase, { kind: 'start' }>;
export type RelayPhase = Extract<Phase, { kind: 'relay' }>;
export type PollPhase = Extract<Phase, { kind: 'poll' }>;
export type StopPhase = Extract<Phase, { kind: 'stop' }>;

/** The jobs that fail and wait on their own: each Devin phase action, each Shortcut call, retirement, and the card link. */
export type Job = 'devin' | 'shortcut' | 'retire' | 'link';

export type SessionState = {
  shortcutSessionId: string;
  workspaceId: string;
  entity: { type: string; id: number };
  context: string;
  turn: number;
  /** The turn the bridge started on. The first Devin session's opening request belongs to it. */
  first: number;
  /** The context of a late `session.created`, waiting to go to the first Devin session ahead of the next reply. */
  late: Pending | null;
  /** Numbers the Devin sessions started for this Shortcut session; the current one is tagged with it. */
  generation: number;
  /** The newest stop's turn. A reply of that turn or an older one is cancelled, however late it arrives. */
  cutoff: number;
  /** The newest turn whose reply reached Devin. An older reply that arrives later is superseded and dropped. */
  sent: number;
  phase: Phase;
  /** Devin sessions the bridge gave up and still has to terminate. */
  retire: Target[];
  /** The Devin URL last set, or given up, on the session card. A phase link that differs is still to be set. */
  linked: string | null;
  outbox: Activity[];
  /** Consecutive failures per job. Each resets on its own success. */
  failures: Record<Job, number>;
  /** No run of that job before this time (ms epoch), whatever events arrive. */
  notBefore: Record<Job, number | null>;
  /** The highest inbox sequence applied, so a step that dies before clearing the inbox applies nothing twice. */
  applied: number;
};

export type DevinState =
  | { kind: 'working' }
  | { kind: 'waiting'; on: 'user' | 'approval' }
  | { kind: 'finished' }
  | { kind: 'failed'; cause: 'error' | 'exit' }
  | { kind: 'failed'; cause: 'suspended'; reason: string };

export type DevinMessage = { id: string; source: string; body: string };

export type DevinSnapshot = { state: DevinState; url: string; pullRequests: string[]; messages: DevinMessage[]; complete: boolean };

export const FIRST_POLL_MS = 5_000;
export const MAX_DELAY_MS = 60_000;
const PICKUP_TIMEOUT_MS = 600_000;
/** No wait is shorter than this, so a `Retry-After` of zero cannot run the same job again in the same alarm. */
export const MIN_WAIT_MS = 1_000;
const MAX_BODY = 32_768;
export const MAX_FAILURES = 8;
/** How often an unresolved tag that finds nothing is looked up before the bridge believes it. */
export const MAX_LOOKUPS = 3;
export const LINK_LABEL = 'Open in Devin';

export const backoffMs = (failures: number) => Math.min(MAX_DELAY_MS, FIRST_POLL_MS * 2 ** (failures - 1));

export const devinTag = (shortcutSessionId: string, generation: number) => `shortcut-session-${shortcutSessionId}-${generation}`;

export const entityUrl = (slug: string, entity: SessionState['entity']) =>
  `https://app.shortcut.com/${encodeURIComponent(slug)}/${entity.type === 'epic' ? 'epic' : 'story'}/${entity.id}`;

export function devinPrompt(state: SessionState, message: string, slug: string): string {
  return [
    message.trim() ? `A Shortcut user asked:\n\n${message}` : `Work on this Shortcut ${state.entity.type}.`,
    `Shortcut ${state.entity.type}: ${entityUrl(slug, state.entity)}`,
    ...(state.context ? [contextBlock(state.context)] : []),
  ].join('\n\n');
}

const contextBlock = (context: string) => `Context from Shortcut:\n\n${context}`;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = Math.max(0, max - 1);
  if (cut > 0 && /[\uD800-\uDBFF]/.test(text[cut - 1])) cut--;
  return `${text.slice(0, cut)}…`;
}

function activity(state: SessionState, suffix: string, type: Activity['content']['type'], body: string, footer = ''): Activity {
  const text = truncate(footer ? `${truncate(body, MAX_BODY - footer.length - 2)}\n\n${footer}` : body, MAX_BODY);
  return { key: `devin-bridge:${state.turn}:${suffix}`, turn: state.turn, content: { type, body: text }, ...(type === 'thought' ? { ephemeral: true as const } : {}) };
}

// Only the newest progress matters, so a thought replaces an unpublished
// thought of its turn and the outbox stays bounded while Shortcut is down. It
// goes last, so Shortcut sees activities in the order they were produced.
// Outcomes are never dropped.
function queued(outbox: Activity[], activity: Activity): Activity[] {
  const kept = activity.content.type === 'thought' ? outbox.filter((a) => !(a.content.type === 'thought' && a.turn === activity.turn)) : outbox;
  return [...kept, activity];
}

const enqueue = (state: SessionState, ...activities: Activity[]): SessionState => ({ ...state, outbox: activities.reduce(queued, state.outbox) });

// Shortcut may add content types without a body; only `prompt` carries text.
function text(event: ShortcutSessionEventPayload): string {
  const content = event.activity?.content;
  return content?.type === 'prompt' && typeof content.body === 'string' ? content.body : '';
}

function contextOf(event: ShortcutSessionEventPayload): string {
  if (event.type !== 'session.created') return '';
  const { text, truncated } = event.prompt_context;
  return truncated ? `${text}\n\n(Shortcut cut this context short.)` : text;
}

const joined = (...parts: string[]) => parts.filter(Boolean).join('\n\n');

const turnOf = (event: ShortcutSessionEventPayload) => event.activity?.turn ?? event.session.turn;

/** The event's reply as a pending prompt, or nothing when it carries no text. */
const said = (event: ShortcutSessionEventPayload): Pending[] => (text(event) ? [{ turn: turnOf(event), text: text(event) }] : []);

/** What Devin reads: the pending replies in turn order. */
export const promptText = (pending: Pending[]) => [...pending].sort((a, b) => a.turn - b.turn).map((p) => p.text).join('\n\n');

export const live = ({ id, url }: Link): Target => ({ kind: 'live', id, url });

/** The Devin session the current phase would have to give up. */
export function targetOf(state: SessionState): Target | null {
  const { phase } = state;
  switch (phase.kind) {
    case 'start': return phase.attempted ? { kind: 'unresolved', tag: devinTag(state.shortcutSessionId, state.generation), lookups: 0 } : null;
    case 'relay':
    case 'poll': return live(phase.link);
    case 'stop': return phase.target;
    case 'idle': return phase.link && live(phase.link);
    case 'closed': return null;
  }
}

/** The current phase's Devin session goes on the retire list. */
export const retiring = (state: SessionState): SessionState => {
  const target = targetOf(state);
  return target ? { ...state, retire: [...state.retire, target] } : state;
};

function initial(event: ShortcutSessionEventPayload): SessionState {
  const { session } = event;
  const state: SessionState = {
    shortcutSessionId: session.id,
    workspaceId: event.workspace_id,
    entity: { type: session.entity_type, id: session.entity_id },
    context: contextOf(event),
    turn: session.turn,
    first: session.turn,
    late: null,
    generation: 1,
    cutoff: 0,
    sent: 0,
    phase: { kind: 'start', prompt: said(event), extra: [], attempted: false },
    retire: [],
    linked: null,
    outbox: [],
    failures: { devin: 0, shortcut: 0, retire: 0, link: 0 },
    notBefore: { devin: null, shortcut: null, retire: null, link: null },
    applied: 0,
  };
  return enqueue(state, activity(state, 'ack', 'thought', 'Starting a Devin session.'));
}

type StopEvent = ShortcutSessionPromptedPayload & { activity: { signal: 'stop' } };
export const isStop = (event: ShortcutSessionEventPayload): event is StopEvent => event.type === 'session.prompted' && event.activity.signal === 'stop';

export function applyEvent(current: SessionState | null, event: ShortcutSessionEventPayload): SessionState | null {
  const stopping = isStop(event);
  if (event.type === 'session.prompted' && !stopping && text(event) === '') return current;
  if (current === null) {
    const state = initial(event);
    return stopping ? stop(state, event.activity.turn) : state;
  }
  if (current.phase.kind === 'closed') return current;
  if (event.type === 'session.created') return merge(current, event);
  const { turn } = event.activity;
  if (stopping) return turn <= current.cutoff ? current : turn >= current.turn ? stop(current, turn) : staleStop(current, turn);
  const reply: Pending = { turn, text: text(event) };
  if (turn < current.turn) return earlier(current, reply);
  if (turn === current.turn) return current;

  const { phase } = current;
  const state: SessionState = { ...current, turn, outbox: current.outbox.filter((a) => a.turn >= turn) };
  const ack = (message: string) => activity(state, 'ack', 'thought', message);
  const relay = (link: Link): Phase => ({ kind: 'relay', link, prompt: [reply], send: null });
  switch (phase.kind) {
    case 'start':
      return enqueue({ ...state, phase: { ...phase, extra: [...phase.extra, reply] } }, ack('Starting a Devin session.'));
    case 'relay':
      return enqueue({ ...state, phase: { ...phase, prompt: [...phase.prompt, reply] } }, ack('Passing your message to Devin.'));
    case 'stop':
      return enqueue({ ...state, phase: { ...phase, then: [...phase.then, reply] } }, ack('Starting a new Devin session.'));
    case 'poll':
      return enqueue({ ...state, phase: relay(phase.link) }, ack('Passing your message to Devin.'));
    case 'idle':
      if (phase.link === null) return startNew(state, [reply]);
      return enqueue({ ...state, phase: relay(phase.link) }, ack('Passing your message to Devin.'));
  }
}

/** The replies Devin has not received yet. A relay counts until its send is confirmed, a start's prompt until its create is attempted, and a stop's replies until they open the next session. */
function unsent(phase: Phase): Pending[] {
  switch (phase.kind) {
    case 'start': return phase.attempted ? phase.extra : [...phase.prompt, ...phase.extra];
    case 'relay': return [...(phase.send?.prompt ?? []), ...phase.prompt];
    case 'stop': return phase.then;
    default: return [];
  }
}

// A reply delivered after a newer one joins what is still unsent; its turn
// places it. One a stop cancelled, or one a sent reply superseded, is dropped.
function earlier(state: SessionState, reply: Pending): SessionState {
  const { phase } = state;
  if (reply.turn <= Math.max(state.cutoff, state.sent)) return state;
  switch (phase.kind) {
    case 'start': return phase.attempted ? { ...state, phase: { ...phase, extra: [...phase.extra, reply] } } : { ...state, phase: { ...phase, prompt: [...phase.prompt, reply] } };
    case 'relay': return { ...state, phase: { ...phase, prompt: [...phase.prompt, reply] } };
    case 'stop': return { ...state, phase: { ...phase, then: [...phase.then, reply] } };
    default: return state;
  }
}

// A stop delivered after the replies that followed it still ends the session
// it meant, and those replies open a new one. The replies up to its turn are
// cancelled with it, whether they arrived already or arrive later. Once every
// later reply was sent, the stop is stale. The ack has its own suffix because
// the turn's `ack` may already be posted with another body, and Shortcut
// answers a reused key with a 409.
function staleStop(state: SessionState, turn: number): SessionState {
  const cancelled = { ...state, cutoff: Math.max(state.cutoff, turn) };
  const then = unsent(state.phase).filter((reply) => reply.turn > turn);
  if (then.length === 0) return cancelled;
  const stopping = stop(cancelled, turn, then);
  return enqueue(stopping, activity(stopping, 'ack:restart', 'thought', 'Starting a new Devin session.'));
}

/** The first Devin session's opening turn is still open: nothing answered it and no newer reply replaced it. */
const opening = ({ generation, turn, first, phase }: SessionState) =>
  generation === 1 && turn === first && (phase.kind === 'start' || phase.kind === 'relay' || phase.kind === 'poll');

// A reply can be delivered before the session.created that opened the session.
// The opening request reaches only the first Devin session: in the create if
// none went out, else as a relayed message while its turn is still open. Once
// that turn has its outcome, or a newer reply was sent, the request is never
// sent again, and the context alone goes ahead of the next reply to that
// session. A later generation gets the context in its create.
function merge(current: SessionState, event: ShortcutSessionEventPayload): SessionState {
  const context = contextOf(event);
  const state = { ...current, context };
  const { phase } = current;
  if (current.generation !== 1) return state;
  if (phase.kind === 'start' && !phase.attempted) return { ...state, phase: { ...phase, prompt: [...phase.prompt, ...said(event)] } };
  if (!opening(current)) return context ? { ...state, late: { turn: turnOf(event), text: contextBlock(context) } } : state;
  const message = joined(text(event), context && contextBlock(context));
  if (!message) return state;
  const request: Pending = { turn: turnOf(event), text: message, opening: true };
  switch (phase.kind) {
    case 'start': return { ...state, phase: { ...phase, extra: [...phase.extra, request] } };
    case 'relay': return { ...state, phase: { ...phase, prompt: [...phase.prompt, request] } };
    case 'poll': return { ...state, phase: { kind: 'relay', link: phase.link, prompt: [request], send: null } };
    default: return state;
  }
}

// The next Devin session's card link starts on a full budget: the strikes were the last link's.
const fresh = (state: SessionState, prompt: Pending[]): SessionState => ({
  ...state,
  generation: state.generation + 1,
  late: null,
  phase: { kind: 'start', prompt, extra: [], attempted: false },
  failures: { ...state.failures, link: 0 },
  notBefore: { ...state.notBefore, link: null },
});

const startNew = (state: SessionState, prompt: Pending[]): SessionState =>
  enqueue(fresh(state, prompt), activity(state, 'ack', 'thought', 'Starting a new Devin session.'));

// Shortcut accepts only a response or an error on a turn with a stop request.
const acceptedAfterStop = (activity: Activity) => activity.content.type === 'response' || activity.content.type === 'error';
function stop(state: SessionState, turn: number, then: Pending[] = []): SessionState {
  const current = Math.max(state.turn, turn);
  return { ...state, turn: current, cutoff: Math.max(state.cutoff, turn), phase: { kind: 'stop', target: targetOf(state), then }, outbox: state.outbox.filter((a) => acceptedAfterStop(a) && a.turn >= current) };
}

// Shortcut refused the activity itself, so a retry cannot help. An outcome
// still has to end the turn, so a short error takes its place, once.
export function rejected(activity: Activity, status: number): Activity | null {
  if (activity.content.type === 'thought' || activity.key.endsWith(':error:rejected')) return null;
  return { key: `devin-bridge:${activity.turn}:error:rejected`, turn: activity.turn, content: { type: 'error', body: `Shortcut rejected Devin's ${activity.content.type} (HTTP ${status}).` } };
}

const linkOf = (phase: Phase): Link | null => ('link' in phase ? phase.link : null);

/** Why Shortcut takes no more writes for the turn: a 409, a revoked grant, or a turn Shortcut ended on its own. */
export type TurnEnd = 'conflict' | 'revoked' | 'ended';

/**
 * Shortcut takes no more writes for the turn. A known Devin session stays
 * usable; anything less certain is retired. A reply not sent yet survives a
 * 409 alone, once a read of the session has shown the turn still open: the
 * event behind the 409, a newer reply or a stop, says what becomes of the
 * reply. The other reasons bring no such event, so the reply is dropped and
 * nothing reaches Devin that Shortcut cannot see.
 */
export function endTurn(state: SessionState, reason: TurnEnd): SessionState {
  if (reason === 'conflict' && state.phase.kind === 'relay') return { ...state, outbox: [] };
  const link = linkOf(state.phase);
  return { ...(link ? keepLate(state) : retiring(state)), phase: { kind: 'idle', link }, outbox: [] };
}

// A relay that never went through still owes the first Devin session the late context it carried.
const keepLate = (state: SessionState): SessionState =>
  state.phase.kind === 'relay' && state.phase.send?.late && !state.late ? { ...state, late: state.phase.send.late } : state;

export const close = (state: SessionState): SessionState => ({ ...retiring(state), phase: { kind: 'closed' }, outbox: [] });

export function fail(state: SessionState, body: string, keep: boolean): SessionState {
  const link = keep ? linkOf(state.phase) : null;
  return enqueue({ ...(link ? keepLate(state) : retiring(state)), phase: { kind: 'idle', link } }, activity(state, 'error', 'error', body));
}

const polling = (link: Link, relayed: Relayed | null, now: number): PollPhase =>
  ({ kind: 'poll', link, at: now + FIRST_POLL_MS, delayMs: FIRST_POLL_MS, check: false, posted: null, asked: null, relayed });

// A quiet Devin session writes nothing, so once the delay is at its cap each
// poll also reads the Shortcut session, or a turn Shortcut ended on its own
// would go unnoticed until Devin spoke again.
const later = (phase: PollPhase, delayMs: number, now: number): PollPhase => ({ ...phase, delayMs, at: now + delayMs, check: delayMs >= MAX_DELAY_MS });

export const checked = (state: SessionState, phase: PollPhase): SessionState => ({ ...state, phase: { ...phase, check: false } });

/** The link job is done with this URL, set or given up, and its strikes with it. */
export const linked = (state: SessionState, url: string): SessionState => ({ ...state, linked: url, failures: { ...state.failures, link: 0 } });

const newest = (sent: number, replies: Pending[]) => Math.max(sent, ...replies.map((reply) => reply.turn));

export function started(state: SessionState, phase: StartPhase, link: Link, now: number): SessionState {
  const { extra } = phase;
  return { ...state, sent: newest(state.sent, phase.prompt), phase: extra.length ? { kind: 'relay', link, prompt: extra, send: null } : polling(link, null, now) };
}

/** The baseline and the text are fixed together, before the send, so a retried send places Devin's answer the same way. */
export const baselined = (state: SessionState, phase: RelayPhase, baseline: Baseline): SessionState =>
  ({ ...state, late: null, phase: { ...phase, prompt: [], send: { prompt: phase.prompt, late: state.late, baseline } } });

/** What the relay sends: a late context first, then the replies in turn order. */
export const sendText = ({ prompt, late }: Send) => promptText(late ? [late, ...prompt] : prompt);

/** The send went through now, so the pickup clock starts here, not at the baseline read. A reply that arrived after the baseline is relayed next. */
export function relayed(state: SessionState, phase: RelayPhase, send: Send, now: number): SessionState {
  const sent = newest(state.sent, send.prompt);
  const waiting = phase.prompt.filter((reply) => reply.opening || reply.turn > sent);
  const next: Phase = waiting.length ? { ...phase, prompt: waiting, send: null } : polling(phase.link, { prompt: sendText(send), baseline: send.baseline, since: now, heard: false }, now);
  return { ...state, sent, phase: next };
}

/** The session a reply was meant for is already over, so the reply opens a new one. */
export function restarted(state: SessionState, phase: RelayPhase): SessionState {
  return enqueue(fresh(retiring(state), unsent(phase)), activity(state, 'restart', 'thought', 'The last Devin session ended. Starting a new one.'));
}

export function stopped(state: SessionState, phase: StopPhase, url: string | null): SessionState {
  if (phase.then.length) return fresh(state, phase.then);
  const body = url ? `Stopped. The Devin session was terminated: ${url}` : 'Stopped.';
  return enqueue({ ...state, phase: { kind: 'idle', link: null } }, activity(state, 'stopped', 'response', body));
}

export const isFinal = (devinState: DevinState) => devinState.kind === 'failed' && devinState.cause !== 'suspended';

const sameState = (a: DevinState, b: DevinState) => JSON.stringify(a) === JSON.stringify(b);

// What Devin said after the relayed reply, so the previous turn's answer never becomes this turn's.
function spoken(messages: DevinMessage[], relayed: Relayed | null): DevinMessage[] {
  const devins = (list: DevinMessage[]) => list.filter((m) => m.source === 'devin');
  if (relayed === null) return devins(messages);
  const { last } = relayed.baseline;
  const at = last === null ? -1 : messages.findIndex((m) => m.id === last);
  if (last !== null && at < 0) return [];
  const after = messages.slice(at + 1);
  const exact = after.findIndex((m) => m.source !== 'devin' && m.body === relayed.prompt);
  const reply = exact >= 0 ? exact : after.findIndex((m) => m.source !== 'devin');
  return reply < 0 ? [] : devins(after.slice(reply + 1));
}

export function observe(state: SessionState, phase: PollPhase, snapshot: DevinSnapshot, now: number): SessionState {
  const devinSaid = snapshot.complete ? spoken(snapshot.messages, phase.relayed) : [];
  const unposted = devinSaid.slice(devinSaid.findIndex((m) => m.id === phase.posted) + 1);
  const last = devinSaid[devinSaid.length - 1] ?? null;
  const link = `[${LINK_LABEL}](${snapshot.url})`;
  const awaiting = phase.relayed && !phase.relayed.heard ? phase.relayed : null;
  const quiet = (current: PollPhase): SessionState => ({ ...state, phase: later(current, Math.min(MAX_DELAY_MS, phase.delayMs * 2), now) });
  if (awaiting && devinSaid.length === 0 && sameState(awaiting.baseline.status, snapshot.state)) {
    if (snapshot.state.kind === 'working' || now - awaiting.since < PICKUP_TIMEOUT_MS) return quiet(phase);
    return fail(state, `Devin did not pick up your reply. Reply to try again. ${link}`, true);
  }
  const heard: PollPhase = { ...phase, relayed: phase.relayed && { ...phase.relayed, heard: true } };

  switch (snapshot.state.kind) {
    case 'working': {
      if (unposted.length === 0) return quiet(heard);
      const latest = unposted[unposted.length - 1];
      return enqueue({ ...state, phase: later({ ...heard, posted: latest.id }, FIRST_POLL_MS, now) }, activity(state, `message:${latest.id}`, 'thought', latest.body || 'Devin is working.'));
    }
    case 'waiting': {
      const fallback = snapshot.state.on === 'user' ? 'Devin is waiting for your input.' : 'Devin is waiting for you to approve an action in Devin.';
      // The suffix names the message, or the kind when the message has no text, so one turn never posts two bodies under one key.
      const suffix = last?.body ? `elicitation:${last.id}` : `elicitation:${snapshot.state.on}`;
      const asked = activity(state, suffix, 'elicitation', last?.body || fallback, link);
      if (snapshot.state.on === 'user') return enqueue({ ...state, phase: { kind: 'idle', link: phase.link } }, asked);
      // An approval happens in Devin, so the turn stays open and the bridge keeps watching for the result. Only a new message is a new question.
      if (heard.asked === suffix) return quiet(heard);
      return enqueue({ ...state, phase: later({ ...heard, asked: suffix, posted: last?.id ?? heard.posted }, FIRST_POLL_MS, now) }, asked);
    }
    case 'finished': {
      const pulls = snapshot.pullRequests.length ? `Pull requests:\n${snapshot.pullRequests.map((pr) => `- ${pr}`).join('\n')}\n\n` : '';
      return enqueue({ ...state, phase: { kind: 'idle', link: phase.link } }, activity(state, 'response', 'response', last?.body || 'Devin finished.', `${pulls}${link}`));
    }
    case 'failed': {
      if (snapshot.state.cause === 'suspended') {
        return fail(state, `The Devin session stopped: suspended (${snapshot.state.reason}). Reply to wake it. ${link}`, true);
      }
      const body = snapshot.state.cause === 'error' ? 'The Devin session ended with an error.' : 'The Devin session was terminated in Devin.';
      return fail(state, `${body} Reply to start a new one. ${link}`, false);
    }
  }
}

/** Every wait passes through here, so the floor holds for a `Retry-After` and a backoff alike. */
export const defer = (state: SessionState, job: Job, ms: number, now: number): SessionState =>
  ({ ...state, notBefore: { ...state.notBefore, [job]: now + Math.max(MIN_WAIT_MS, ms) } });

export const succeeded = (state: SessionState, job: Job): SessionState => ({ ...state, failures: { ...state.failures, [job]: 0 } });

export type ActPhase = StartPhase | RelayPhase | PollPhase;

/** A job and the earliest time (ms epoch) it may run. The phase jobs carry the phase they act on. */
export type Due = { at: number } & (
  | { effect: 'terminate'; phase: StopPhase }
  | { effect: 'retire' }
  | { effect: 'publish' }
  | { effect: 'link'; url: string }
  | { effect: 'check'; phase: PollPhase }
  | { effect: 'act'; phase: ActPhase }
);

/**
 * Every job the state calls for and the earliest time it may run, soonest
 * first. Each Devin job waits only on the Devin deadline, each Shortcut job
 * only on the Shortcut deadline, and retirement and the card link on their
 * own as well. Ties keep this order: a stop's terminate, retirement, the
 * Shortcut jobs (the next write, the card link, the quiet-poll read), then
 * the phase's Devin work. The first two need no Shortcut credentials.
 */
export function plan(state: SessionState, now: number): Due[] {
  const { phase, notBefore } = state;
  const at = (...deadlines: (number | null)[]) => Math.max(now, ...deadlines.map((deadline) => deadline ?? now));
  const due: Due[] = [];
  const link = linkOf(phase);
  if (phase.kind === 'stop') due.push({ effect: 'terminate', phase, at: at(notBefore.devin) });
  if (state.retire.length) due.push({ effect: 'retire', at: at(notBefore.devin, notBefore.retire) });
  if (state.outbox.length) due.push({ effect: 'publish', at: at(notBefore.shortcut) });
  if (link && link.url !== state.linked) due.push({ effect: 'link', url: link.url, at: at(notBefore.shortcut, notBefore.link) });
  if (phase.kind === 'poll' && phase.check) due.push({ effect: 'check', phase, at: at(notBefore.shortcut, phase.at) });
  if (phase.kind === 'start' || phase.kind === 'relay') due.push({ effect: 'act', phase, at: at(notBefore.devin) });
  if (phase.kind === 'poll') due.push({ effect: 'act', phase, at: at(notBefore.devin, phase.at) });
  return due.sort((a, b) => a.at - b.at);
}

export const dueAt = (state: SessionState, now: number): number | null => plan(state, now)[0]?.at ?? null;

export function dueNow(state: SessionState, now: number): Due | null {
  const [first] = plan(state, now);
  return first && first.at <= now ? first : null;
}
