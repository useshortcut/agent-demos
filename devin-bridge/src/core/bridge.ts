import type { ShortcutSessionEventPayload, ShortcutSessionPromptedPayload } from '@shortcut/client/webhooks';
import { identity, type Memo } from '../backend';
import type { Conversation, Halted, Observed, Opened, Prepared, Target } from './port';

export type Activity = {
  key: string;
  turn: number;
  content: { type: 'thought' | 'elicitation' | 'response' | 'error'; body: string };
  ephemeral?: true;
};

type Live = Conversation<Memo>;

type Held = Target<Memo>;

/**
 * A request the agent has not received yet. Its turn orders it among the
 * others, whatever order they arrived in. The request of a late
 * `session.created` that could not join the opening text waits in one of two
 * forms. `opening`: a newer reply never supersedes it. `superseded`: newer
 * replies had arrived before it, so it goes only into an introduction, where
 * nothing has reached the agent yet.
 */
export type Pending = { turn: number; text: string } & ({ opening?: never; superseded?: never } | { opening: true; superseded?: never } | { opening?: never; superseded: true });

/** What one relay sends, fixed when it is prepared, so a retried send repeats the same text under the same key and places the answer the same way. `briefs`: the text carries Shortcut's context. */
export type Send = { prompt: Pending[]; briefs: boolean; text: string; key: string; memo: Memo };

export type Phase =
  /** An open's text is fixed when it is first attempted: `prompt`, and Shortcut's context when `briefs`. What arrives after that waits in `extra`. */
  | { kind: 'start'; prompt: Pending[]; extra: Pending[]; attempted: false }
  | { kind: 'start'; prompt: Pending[]; extra: Pending[]; attempted: true; briefs: boolean }
  /** Until `send` is set, `prompt` is what the next prepare fixes. After, it waits for the relay that follows. `working`: the agent holds a text it has not answered, so a relay that gives up with no request to send goes back to reading it. */
  | { kind: 'relay'; on: Live; prompt: Pending[]; send: Send | null; working: boolean }
  /** `check` asks for a Shortcut read of the session with the next poll. `posted` is the id of the last message written to Shortcut, and `asked` the key suffix of the elicitation. `sentAt` starts the pickup clock. `heartbeatAt` is when a quiet, working agent is next reported to Shortcut. */
  | { kind: 'poll'; on: Live; at: number; delayMs: number; check: boolean; posted: string | null; asked: string | null; sentAt: number; heartbeatAt: number }
  | { kind: 'stop'; target: Held | null; waiting: Pending[] }
  /** `dropped`: the requests of a turn that ended in an error before they reached the agent. Set until Shortcut takes that error, and a newer reply that arrives before then takes them along. */
  | { kind: 'idle'; on: Live | null; dropped?: Pending[] }
  | { kind: 'closed' };

export type StartPhase = Extract<Phase, { kind: 'start' }>;
export type Attempted = Extract<StartPhase, { attempted: true }>;
export type RelayPhase = Extract<Phase, { kind: 'relay' }>;
export type PollPhase = Extract<Phase, { kind: 'poll' }>;
export type StopPhase = Extract<Phase, { kind: 'stop' }>;

/** The jobs that fail and wait on their own: each backend phase action, each Shortcut call, retirement, and the card link. */
export type Job = 'backend' | 'shortcut' | 'retire' | 'link';

export type SessionState = {
  /** Names this shape. A stored state under any other tag is dropped. */
  v: 3;
  shortcutSessionId: string;
  workspaceId: string;
  entity: { type: string; id: number };
  context: string;
  turn: number;
  /** The turn the bridge started on. The first conversation's opening request belongs to it. */
  first: number;
  /**
   * Whether the current conversation was told Shortcut's context. `owed`: not
   * as far as the bridge knows, so the next text fixed for the conversation
   * carries it. `introduced`: an introduction that carries it was prepared
   * while the conversation was empty, and only the backend can say whether it
   * landed. `given`: a text that carries it was confirmed. A fixed text
   * records only that it carries the context (`briefs`). The debt changes
   * when that text is confirmed, so a text that is dropped leaves it owed.
   */
  briefing: 'owed' | 'introduced' | 'given';
  /** Numbers the conversations opened for this Shortcut session; the current one's key carries it. */
  generation: number;
  /** The newest stop's turn. A reply of that turn or an older one is cancelled, however late it arrives. */
  cutoff: number;
  /** The newest turn whose reply reached the agent. An older reply that arrives later is superseded and dropped. */
  sent: number;
  /** The newest turn whose request the bridge knows the current conversation holds, and 0 when it knows of none. `sent` counts every conversation of the session, and this counts only the current one. A stop of an older turn halts nothing there. */
  landed: number;
  phase: Phase;
  /** Conversations the bridge gave up and still has to halt. */
  retire: Held[];
  /** The conversation URL last set, or given up, on the session card. A phase link that differs is still to be set. */
  linked: string | null;
  outbox: Activity[];
  /** Consecutive failures per job. Each resets on its own success. */
  failures: Record<Job, number>;
  /** No run of that job before this time (ms epoch), whatever events arrive. */
  notBefore: Record<Job, number | null>;
  /** The highest inbox sequence applied, so a step that dies before clearing the inbox applies nothing twice. */
  applied: number;
};

export const FIRST_POLL_MS = 5_000;
export const MAX_DELAY_MS = 60_000;
const PICKUP_TIMEOUT_MS = 600_000;
/** Shortcut marks a session stale after 30 minutes without agent activity, so an agent that works quietly is reported well inside that. */
const HEARTBEAT_MS = 600_000;
/** No wait is shorter than this, so a `Retry-After` of zero cannot run the same job again in the same alarm. */
export const MIN_WAIT_MS = 1_000;
const MAX_BODY = 32_768;
export const MAX_FAILURES = 8;
/** How often an unresolved key that finds nothing is looked up before the bridge believes it. */
export const MAX_LOOKUPS = 3;

export const backoffMs = (failures: number) => Math.min(MAX_DELAY_MS, FIRST_POLL_MS * 2 ** (failures - 1));

export const conversationKey = (shortcutSessionId: string, generation: number) => `shortcut-session-${shortcutSessionId}-${generation}`;

/**
 * Names one prepared send by the inbox sequence applied when it was prepared.
 * A relay waits to be prepared only after an event that arrived since the
 * last send was prepared: a reply, a stop, or a late `session.created`. So no
 * two sends of a session share a sequence, and the count needs no state of
 * its own.
 */
export const sendKey = (state: Pick<SessionState, 'shortcutSessionId' | 'generation' | 'applied'>) => `${conversationKey(state.shortcutSessionId, state.generation)}:${state.applied}`;

export const entityUrl = (slug: string, entity: SessionState['entity']) =>
  `https://app.shortcut.com/${encodeURIComponent(slug)}/${entity.type === 'epic' ? 'epic' : 'story'}/${entity.id}`;

function introduction(state: SessionState, message: string, slug: string, briefs: boolean): string {
  return [
    message.trim() ? `A Shortcut user asked:\n\n${message}` : `Work on this Shortcut ${state.entity.type}.`,
    `Shortcut ${state.entity.type}: ${entityUrl(slug, state.entity)}`,
    ...(briefs ? [contextBlock(state.context)] : []),
  ].join('\n\n');
}

const contextBlock = (context: string) => `Context from Shortcut:\n\n${context}`;

/** There is a context, and `briefing` says the conversation is owed it. An introduction whose answer is unknown does not count as owing. */
const owes = (state: SessionState) => state.context !== '' && state.briefing === 'owed';

/** Marks the open as attempted and records whether its text carries the context: it does when one has arrived. `openingText` builds the same text from that for every attempt. */
export const attempting = (state: SessionState, phase: StartPhase): SessionState => ({ ...state, phase: { ...phase, attempted: true, briefs: state.context !== '' } });

export const openingText = (state: SessionState, phase: Attempted, slug: string): string => introduction(state, promptText(phase.prompt), slug, phase.briefs);

function truncate(body: string, max: number): string {
  if (body.length <= max) return body;
  let cut = Math.max(0, max - 1);
  if (cut > 0 && /[\uD800-\uDBFF]/.test(body[cut - 1])) cut--;
  return `${body.slice(0, cut)}…`;
}

function activity(state: SessionState, suffix: string, type: Activity['content']['type'], body: string, footer = ''): Activity {
  const capped = truncate(footer ? `${truncate(body, MAX_BODY - footer.length - 2)}\n\n${footer}` : body, MAX_BODY);
  return { key: `${identity.slug}:${state.turn}:${suffix}`, turn: state.turn, content: { type, body: capped }, ...(type === 'thought' ? { ephemeral: true as const } : {}) };
}

// Only the newest progress matters, so a thought replaces an unpublished
// thought of its turn and the outbox stays bounded while Shortcut is down. It
// goes last, so Shortcut sees activities in the order they were produced.
// Outcomes are never dropped.
function queued(outbox: Activity[], added: Activity): Activity[] {
  const kept = added.content.type === 'thought' ? outbox.filter((a) => !(a.content.type === 'thought' && a.turn === added.turn)) : outbox;
  return [...kept, added];
}

const enqueue = (state: SessionState, ...activities: Activity[]): SessionState => ({ ...state, outbox: activities.reduce(queued, state.outbox) });

// Shortcut may add content types without a body; only `prompt` carries text.
function text(event: ShortcutSessionEventPayload): string {
  const content = event.activity?.content;
  return content?.type === 'prompt' && typeof content.body === 'string' ? content.body : '';
}

function contextOf(event: ShortcutSessionEventPayload): string {
  if (event.type !== 'session.created') return '';
  const { text: context, truncated } = event.prompt_context;
  return truncated ? `${context}\n\n(Shortcut cut this context short.)` : context;
}

const joined = (...parts: string[]) => parts.filter(Boolean).join('\n\n');

const linkedBody = (body: string, link: string) => (link ? `${body} ${link}` : body);

const turnOf = (event: ShortcutSessionEventPayload) => event.activity?.turn ?? event.session.turn;

/** The event's reply as a pending prompt, or nothing when it carries no text. */
const said = (event: ShortcutSessionEventPayload): Pending[] => (text(event) ? [{ turn: turnOf(event), text: text(event) }] : []);

/** The texts of the pending requests in turn order, a blank line between them. */
const promptText = (pending: Pending[]) => [...pending].sort((a, b) => a.turn - b.turn).map((p) => p.text).join('\n\n');

/** What a message reads when it carries Shortcut's context: the context under the opening request, or ahead of the replies when it carries none. */
function briefedText(pending: Pending[], context: string): string {
  const ordered = [...pending].sort((a, b) => a.turn - b.turn);
  const under = ordered.findIndex((reply) => reply.opening) + 1;
  return [promptText(ordered.slice(0, under)), contextBlock(context), promptText(ordered.slice(under))].filter(Boolean).join('\n\n');
}

/** The requests without their `opening` and `superseded` marks, for an opening text or an introduction. Nothing has reached the conversation, so both take every request alike. */
const unmarked = (pending: Pending[]): Pending[] => pending.map((reply) => ({ turn: reply.turn, text: reply.text }));

export const live = (conversation: Live): Held => ({ kind: 'live', conversation });

/** The conversation the current phase would have to give up. */
export function targetOf(state: SessionState): Held | null {
  const { phase } = state;
  switch (phase.kind) {
    case 'start': return phase.attempted ? { kind: 'unresolved', key: conversationKey(state.shortcutSessionId, state.generation), lookups: 0 } : null;
    case 'relay':
    case 'poll': return live(phase.on);
    case 'stop': return phase.target;
    case 'idle': return phase.on && live(phase.on);
    case 'closed': return null;
  }
}

/** The current phase's conversation goes on the retire list. */
export const retiring = (state: SessionState): SessionState => {
  const target = targetOf(state);
  return target ? { ...state, retire: [...state.retire, target] } : state;
};

function initial(event: ShortcutSessionEventPayload): SessionState {
  const { session } = event;
  const state: SessionState = {
    v: 3,
    shortcutSessionId: session.id,
    workspaceId: event.workspace_id,
    entity: { type: session.entity_type, id: session.entity_id },
    context: contextOf(event),
    turn: session.turn,
    first: session.turn,
    briefing: 'owed',
    generation: 1,
    cutoff: 0,
    sent: 0,
    landed: 0,
    phase: { kind: 'start', prompt: said(event), extra: [], attempted: false },
    retire: [],
    linked: null,
    outbox: [],
    failures: { backend: 0, shortcut: 0, retire: 0, link: 0 },
    notBefore: { backend: null, shortcut: null, retire: null, link: null },
    applied: 0,
  };
  return enqueue(state, activity(state, 'ack', 'thought', `Starting ${identity.aSession}.`));
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
  switch (phase.kind) {
    case 'start':
      return enqueue({ ...state, phase: { ...phase, extra: [...phase.extra, reply] } }, ack(`Starting ${identity.aSession}.`));
    case 'relay':
      return enqueue({ ...state, phase: { ...phase, prompt: [...phase.prompt, reply] } }, ack(`Passing your message to ${identity.name}.`));
    case 'stop':
      return enqueue({ ...state, phase: { ...phase, waiting: [...phase.waiting, reply] } }, ack(`Starting a new ${identity.name} session.`));
    case 'poll':
      return enqueue({ ...state, phase: relaying(phase.on, [reply], true) }, ack(`Passing your message to ${identity.name}.`));
    case 'idle': {
      const prompt = [...(phase.dropped ?? []).filter((dropped) => dropped.turn > state.cutoff), reply];
      if (phase.on === null) return startNew(state, prompt);
      return enqueue({ ...state, phase: relaying(phase.on, prompt, false) }, ack(`Passing your message to ${identity.name}.`));
    }
  }
}

const relaying = (on: Live, prompt: Pending[], working: boolean): RelayPhase => ({ kind: 'relay', on, prompt, send: null, working });

/** The replies the agent has not received yet. A relay counts until its send is confirmed, a start's prompt until its open is attempted, and a stop's replies until they open the next session. */
function unsent(phase: Phase): Pending[] {
  switch (phase.kind) {
    case 'start': return phase.attempted ? phase.extra : [...phase.prompt, ...phase.extra];
    case 'relay': return [...(phase.send?.prompt ?? []), ...phase.prompt];
    case 'stop': return phase.waiting;
    case 'poll':
    case 'idle':
    case 'closed': return [];
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
    case 'stop': return { ...state, phase: { ...phase, waiting: [...phase.waiting, reply] } };
    // Shortcut has not taken the failed turn's error, so the reply joins what the turn dropped. After that it is dropped on arrival.
    case 'idle': return phase.dropped ? { ...state, phase: { ...phase, dropped: [...phase.dropped, reply] } } : state;
    case 'poll':
    case 'closed': return state;
  }
}

// A stop delivered after the replies that followed it. The replies up to its
// turn are cancelled with it, whether they arrived already or arrive later.
// `RULES.halted` in runtime-tests/bridge/ledger.mjs says when it also ends
// the conversation it meant. Once the conversation holds a request newer
// than the stop, the stop is stale: the agent works on what came after it,
// so nothing is halted, the cancelled replies that still wait are dropped
// where they wait, and the later ones go to the same conversation. The same
// holds once no later reply is left unsent. Otherwise the conversation is
// halted and the later replies open a new one. An open that was attempted
// and not answered is the exception. Its text is fixed and may not be out
// yet, so if it holds a cancelled reply the open is stopped whole. Whenever
// the open is stopped, what its text held after the stop's turn opens the
// next conversation with the replies that waited. The ack has its own suffix
// because the turn's `ack` may already be posted with another body, and
// Shortcut answers a reused key with a 409.
function staleStop(state: SessionState, turn: number): SessionState {
  const { phase } = state;
  const cancelled = { ...state, cutoff: Math.max(state.cutoff, turn) };
  const after = (replies: Pending[]) => replies.filter((reply) => reply.turn > turn);
  const fixed = phase.kind === 'start' && phase.attempted ? phase.prompt : [];
  const waiting = after(unsent(phase));
  const movedOn = conversationOf(phase) !== null && state.landed > turn;
  if (movedOn || (waiting.length === 0 && after(fixed).length === fixed.length)) {
    // An open that has not gone out held only what the stop cancelled, so nothing is left to open a conversation for. Only a conversation that replaces one that ended is in that place: the bridge started from a reply the stop cannot cancel.
    const nothing = phase.kind === 'start' && !phase.attempted;
    return nothing ? fail(cancelled, `The ${identity.name} session ended. Reply to start a new one.`, false) : { ...cancelled, phase: without(phase, turn) };
  }
  const stopping = stop(cancelled, turn, [...after(fixed), ...waiting]);
  return enqueue(stopping, activity(stopping, 'ack:restart', 'thought', `Starting a new ${identity.name} session.`));
}

/** The phase without the unsent replies up to `turn`. A prepared send that holds one is dropped whole, since its text is fixed, and what it held after `turn` waits to be prepared again. */
function without(phase: Phase, turn: number): Phase {
  const after = (replies: Pending[]) => replies.filter((reply) => reply.turn > turn);
  switch (phase.kind) {
    case 'start': return { ...phase, extra: after(phase.extra) };
    case 'relay': {
      const { send } = phase;
      return send?.prompt.some((reply) => reply.turn <= turn) ? { ...phase, prompt: after([...send.prompt, ...phase.prompt]), send: null } : { ...phase, prompt: after(phase.prompt) };
    }
    case 'stop': return { ...phase, waiting: after(phase.waiting) };
    case 'poll':
    case 'idle':
    case 'closed': return phase;
  }
}

/** No reply newer than the one the bridge started from has arrived, and the bridge is opening a conversation, relaying to it, or reading it. That holds for the first conversation and for one that replaced it. */
const opening = ({ turn, first, phase }: SessionState) => turn === first && (phase.kind === 'start' || phase.kind === 'relay' || phase.kind === 'poll');

// A session.created that arrives after the bridge started from a reply. It
// brings Shortcut's context and the opening request. `RULES.briefed`,
// `RULES.stopped`, and `RULES.superseded` in
// runtime-tests/bridge/ledger.mjs say what the agent is owed of each. Here
// the context is stored, and the request is put where it waits:
//
// - nowhere, when a stop cancelled it, when the bridge is on a later
//   conversation and past the turn it started from, when it reads a
//   conversation and `opening()` no longer holds, or when it is stopping or
//   idle
// - in the text of an open that has not gone out
// - marked `opening` while `opening()` holds, else `superseded`, beside an
//   attempted open or in a relay
//
// A conversation the bridge is reading is relayed to at once while
// `opening()` holds, with the request or with the context alone.
function merge(current: SessionState, event: ShortcutSessionEventPayload): SessionState {
  const state = { ...current, context: contextOf(event) };
  const { phase } = current;
  const turn = turnOf(event);
  const asked = turn > current.cutoff && (current.generation === 1 || current.turn === current.first) ? text(event) : '';
  if (phase.kind === 'start' && !phase.attempted) return asked ? { ...state, phase: { ...phase, prompt: [...phase.prompt, { turn, text: asked }] } } : state;
  const request: Pending[] = asked ? [opening(current) ? { turn, text: asked, opening: true } : { turn, text: asked, superseded: true }] : [];
  switch (phase.kind) {
    case 'start': return { ...state, phase: { ...phase, extra: [...phase.extra, ...request] } };
    case 'relay': return { ...state, phase: { ...phase, prompt: [...phase.prompt, ...request] } };
    case 'poll': return opening(current) && (request.length || owes(state)) ? { ...state, phase: relaying(phase.on, request, true) } : state;
    case 'stop':
    case 'idle':
    case 'closed': return state;
  }
}

// The next conversation's card link starts on a full budget: the strikes were the last link's.
const fresh = (state: SessionState, prompt: Pending[]): SessionState => ({
  ...state,
  generation: state.generation + 1,
  briefing: 'owed',
  landed: 0,
  phase: { kind: 'start', prompt, extra: [], attempted: false },
  failures: { ...state.failures, link: 0 },
  notBefore: { ...state.notBefore, link: null },
});

const startNew = (state: SessionState, prompt: Pending[]): SessionState =>
  enqueue(fresh(state, prompt), activity(state, 'ack', 'thought', `Starting a new ${identity.name} session.`));

// Shortcut accepts only a response or an error on a turn with a stop request.
const acceptedAfterStop = (unpublished: Activity) => unpublished.content.type === 'response' || unpublished.content.type === 'error';
function stop(state: SessionState, turn: number, waiting: Pending[] = []): SessionState {
  const current = Math.max(state.turn, turn);
  return { ...state, turn: current, cutoff: Math.max(state.cutoff, turn), phase: { kind: 'stop', target: targetOf(state), waiting }, outbox: state.outbox.filter((a) => acceptedAfterStop(a) && a.turn >= current) };
}

// Shortcut refused the activity itself, so a retry cannot help. An outcome
// still has to end the turn, so a short error takes its place, once.
export function rejected(refused: Activity, status: number): Activity | null {
  if (refused.content.type === 'thought' || refused.key.endsWith(':error:rejected')) return null;
  return { key: `${identity.slug}:${refused.turn}:error:rejected`, turn: refused.turn, content: { type: 'error', body: `Shortcut rejected ${identity.name}'s ${refused.content.type} (HTTP ${status}).` } };
}

const conversationOf = (phase: Phase): Live | null => ('on' in phase ? phase.on : null);

/** Why Shortcut takes no more writes for the turn: a 409, a revoked grant, or a turn Shortcut ended on its own. */
export type TurnEnd = 'conflict' | 'revoked' | 'ended';

/**
 * Shortcut takes no more writes for the turn. A known conversation stays
 * usable; anything less certain is retired. A request not sent yet survives
 * a 409 alone, once a read of the session has shown the turn still open: the
 * event behind the 409, a newer reply or a stop, says what becomes of the
 * request. That holds for a reply that waits in a relay and for what an open
 * that has no answer yet carries, the opening request included. The other
 * reasons bring no such event, so the request is dropped and nothing reaches
 * the agent that Shortcut cannot see.
 */
export function endTurn(state: SessionState, reason: TurnEnd): SessionState {
  // A 409 leaves a start and a relay as they are, and leaves an idle phase what its failed turn dropped. Only the outbox is emptied.
  if (reason === 'conflict' && (state.phase.kind === 'start' || state.phase.kind === 'relay' || state.phase.kind === 'idle')) return { ...state, outbox: [] };
  const on = conversationOf(state.phase);
  return { ...(on ? state : retiring(state)), phase: { kind: 'idle', on }, outbox: [] };
}

export const close = (state: SessionState): SessionState => ({ ...retiring(state), phase: { kind: 'closed' }, outbox: [] });

export function fail(state: SessionState, body: string, keep: boolean): SessionState {
  const { phase } = state;
  const on = keep ? conversationOf(phase) : null;
  // A failed open delivered nothing the bridge knows of, so what its text held is dropped with what waited.
  const dropped = unmarked((phase.kind === 'start' ? [...phase.prompt, ...phase.extra] : unsent(phase)).filter((reply) => !reply.superseded));
  return enqueue({ ...(on ? state : retiring(state)), phase: { kind: 'idle', on, ...(dropped.length ? { dropped } : {}) } }, activity(state, 'error', 'error', body));
}

/** Shortcut took the first activity of the outbox. Once it has a turn's error, the user knows to send again what the turn dropped. */
export function published(state: SessionState): SessionState {
  const { phase } = state;
  const [taken, ...outbox] = state.outbox;
  return { ...state, outbox, phase: taken.content.type === 'error' && phase.kind === 'idle' ? { kind: 'idle', on: phase.on } : phase };
}

const polling = (on: Live, now: number): PollPhase =>
  ({ kind: 'poll', on, at: now + FIRST_POLL_MS, delayMs: FIRST_POLL_MS, check: false, posted: null, asked: null, sentAt: now, heartbeatAt: now + HEARTBEAT_MS });

// A quiet agent writes nothing, so once the delay is at its cap each poll
// also reads the Shortcut session, or a turn Shortcut ended on its own would
// go unnoticed until the agent spoke again.
const later = (phase: PollPhase, delayMs: number, now: number): PollPhase => ({ ...phase, delayMs, at: now + delayMs, check: delayMs >= MAX_DELAY_MS });

export const checked = (state: SessionState, phase: PollPhase): SessionState => ({ ...state, phase: { ...phase, check: false } });

/** The link job is done with this URL, set or given up, and its strikes with it. */
export const linked = (state: SessionState, url: string): SessionState => ({ ...state, linked: url, failures: { ...state.failures, link: 0 } });

const newest = (sent: number, replies: Pending[]) => Math.max(sent, ...replies.map((reply) => reply.turn));

export function started(state: SessionState, phase: Attempted, { conversation: on, delivered }: Opened<Memo>, now: number): SessionState {
  if (!delivered) return { ...state, phase: relaying(on, [...phase.prompt, ...phase.extra], false) };
  const told: SessionState = { ...state, sent: newest(state.sent, phase.prompt), landed: newest(state.landed, phase.prompt), briefing: phase.briefs ? 'given' : state.briefing };
  const extra = phase.extra.filter((reply) => !reply.superseded);
  return { ...told, phase: extra.length || (owes(told) && opening(told)) ? relaying(on, extra, true) : polling(on, now) };
}

/**
 * The memo, the text, and the key are fixed together, before the send, so a
 * retried send is the same send and places the agent's answer the same way.
 * The backend's answer decides what the text is, here and nowhere else. A
 * conversation it finds empty gets the introduction, which carries
 * Shortcut's context itself. One that holds a message gets the requests in
 * turn order, with the context if the conversation is still owed it. A
 * message there also settles an introduction whose answer the bridge never
 * got: it landed, so it is not repeated. A text goes out with no request
 * only while the bridge is on the turn it started from: the introduction of a
 * session created without one, or a context that arrived late. `readsFirst`
 * says when the second waits behind a read of the agent.
 */
export function prepared(state: SessionState, phase: RelayPhase, { memo, empty }: Extract<Prepared<Memo>, { kind: 'ready' }>, slug: string, now: number): SessionState {
  const settled: SessionState = !empty && state.briefing === 'introduced' ? { ...state, briefing: 'given' } : state;
  const prompt = empty ? unmarked(phase.prompt) : phase.prompt.filter((reply) => !reply.superseded);
  const briefs = settled.context !== '' && (empty || owes(settled));
  // A text goes out with no request only on the turn the bridge started from: the introduction of the first conversation, for a session created without a request, or the context alone.
  const alone = opening(settled) && (empty ? settled.generation === 1 : briefs);
  if (prompt.length === 0 && !alone) {
    // A stop cancelled all this relay held, or all it held was superseded. An empty conversation that is not the first replaced one that ended, and nothing is left to open it for. An agent that was told something still works on it, so the bridge goes back to reading it.
    return empty ? fail(settled, `The ${identity.name} session ended. Reply to start a new one.`, false) : { ...settled, phase: polling(phase.on, now) };
  }
  // oxlint-disable-next-line eslint/no-shadow -- runtime-tests/bridge/broken-cores.test.mjs breaks this function by these lines, and both names are in them
  const text = empty ? introduction(settled, promptText(prompt), slug, briefs) : briefs ? briefedText(prompt, settled.context) : promptText(prompt);
  return { ...settled, briefing: empty && briefs ? 'introduced' : settled.briefing, phase: { ...phase, prompt: [], send: { prompt, briefs, text, key: sendKey(state), memo } } };
}

/** The send went through now, so the pickup clock starts here, not at the prepare. What arrived after the prepare is relayed next. */
export function relayed(state: SessionState, phase: RelayPhase, send: Send, memo: Memo, now: number): SessionState {
  const sent = newest(state.sent, send.prompt);
  const on: Live = { ...phase.on, memo };
  const told: SessionState = { ...state, sent, landed: newest(state.landed, send.prompt), briefing: send.briefs ? 'given' : state.briefing };
  const waiting = phase.prompt.filter((reply) => reply.opening || reply.turn > sent);
  return { ...told, phase: waiting.length || (owes(told) && opening(told)) ? { ...phase, on, prompt: waiting, send: null, working: true } : polling(on, now) };
}

/**
 * A relay's backend call was refused, or failed until its strikes were spent.
 * Null when that ends the turn: the relay held a request, or no agent was at
 * work. Otherwise all it held was Shortcut's context, or what a stop
 * cancelled, and the agent is still answering the turn. The bridge goes back
 * to reading it, and the context stays owed for the next reply. A reply that
 * arrived behind a prepared send of the context alone is prepared next, and
 * takes the context with it.
 */
export function abandoned(state: SessionState, phase: RelayPhase, now: number): SessionState | null {
  if (!phase.working || phase.send?.prompt.length) return null;
  const asked = phase.prompt.some((reply) => !reply.superseded);
  if (phase.send === null) return asked ? null : { ...state, phase: polling(phase.on, now) };
  return { ...state, phase: asked ? { ...phase, send: null } : polling(phase.on, now) };
}

/**
 * The session a reply was meant for is already over, so the reply opens a new
 * one. A conversation that is gone while still empty is not replaced: the next
 * one would stand where it stood, and a backend whose new conversations are
 * all gone would have the bridge open them without a wait or an end. The turn
 * fails, and the next reply opens one. The conversation that is gone held a
 * message, so a superseded request stays behind with it. When no request
 * waited, only Shortcut's context, there is nothing to open a conversation
 * for. The bridge reads the conversation instead, and that read ends the turn
 * with the backend's own reason and the link.
 */
export function restarted(state: SessionState, phase: RelayPhase, empty: boolean, now: number): SessionState {
  if (empty) return fail(state, `The ${identity.name} session ended before it took your message. Reply to start a new one.`, false);
  const waiting = unmarked(unsent(phase).filter((reply) => !reply.superseded));
  if (waiting.length === 0) return { ...state, phase: polling(phase.on, now) };
  return enqueue(fresh(retiring(state), waiting), activity(state, 'restart', 'thought', `The last ${identity.name} session ended. Starting a new one.`));
}

/**
 * A stop's halt is answered. A conversation the backend kept takes the replies
 * that waited on the stop, or stays for the next one, and nothing is said to
 * be terminated. Any other conversation is over: the replies open a new one.
 */
export function stopped(state: SessionState, phase: StopPhase, halted: Halted): SessionState {
  const kept = halted.kind === 'kept' && phase.target?.kind === 'live' ? phase.target.conversation : null;
  if (phase.waiting.length) {
    if (kept === null) return fresh(state, phase.waiting);
    // The replies were acknowledged as starting a new session before the halt was answered. This takes that ack's place under its own suffix, since the ack may already be posted.
    return enqueue({ ...state, phase: relaying(kept, phase.waiting, false) }, activity(state, 'ack:kept', 'thought', `Passing your message to ${identity.name}.`));
  }
  const url = halted.kind === 'ended' ? halted.url : null;
  const body = url ? `Stopped. The ${identity.name} session was terminated: ${url}` : 'Stopped.';
  return enqueue({ ...state, phase: { kind: 'idle', on: kept } }, activity(state, 'stopped', 'response', body));
}

export function observed(state: SessionState, phase: PollPhase, { memo, said: messages, status }: Observed<Memo>, now: number): SessionState {
  const unposted = messages.slice(messages.findIndex((m) => m.id === phase.posted) + 1);
  const last = messages[messages.length - 1] ?? null;
  const link = phase.on.url ? `[${identity.linkLabel}](${phase.on.url})` : '';
  const current: PollPhase = { ...phase, on: { ...phase.on, memo } };
  const quiet = (beat: boolean): SessionState => {
    const next = later(current, Math.min(MAX_DELAY_MS, phase.delayMs * 2), now);
    if (!beat || now < current.heartbeatAt) return { ...state, phase: next };
    // Repeating the newest message keeps it on the card, since each thought replaces the one before.
    return enqueue({ ...state, phase: { ...next, heartbeatAt: now + HEARTBEAT_MS } }, activity(state, `heartbeat:${now}`, 'thought', last?.text || `${identity.name} is still working.`));
  };

  switch (status.kind) {
    case 'pending':
      if (now - phase.sentAt < PICKUP_TIMEOUT_MS) return quiet(false);
      return fail(state, linkedBody(`${identity.name} did not pick up your reply. Reply to try again.`, link), true);
    case 'working': {
      if (unposted.length === 0) return quiet(true);
      const latest = unposted[unposted.length - 1];
      return enqueue({ ...state, phase: later({ ...current, posted: latest.id, heartbeatAt: now + HEARTBEAT_MS }, FIRST_POLL_MS, now) }, activity(state, `message:${latest.id}`, 'thought', latest.text || `${identity.name} is working.`));
    }
    case 'asked': {
      const fallback = status.on === 'user' ? `${identity.name} is waiting for your input.` : `${identity.name} is waiting for you to approve an action in ${identity.name}.`;
      // The suffix names the message, or the kind when the message has no text, so one turn never posts two bodies under one key.
      const suffix = last?.text ? `elicitation:${last.id}` : `elicitation:${status.on}`;
      const asked = activity(state, suffix, 'elicitation', last?.text || fallback, link);
      if (status.on === 'user') return enqueue({ ...state, phase: { kind: 'idle', on: current.on } }, asked);
      // An approval happens in the agent's own app, so the turn stays open and the bridge keeps watching for the result. Only a new message is a new question.
      if (current.asked === suffix) return quiet(false);
      return enqueue({ ...state, phase: later({ ...current, asked: suffix, posted: last?.id ?? current.posted, heartbeatAt: now + HEARTBEAT_MS }, FIRST_POLL_MS, now) }, asked);
    }
    case 'finished':
      return enqueue({ ...state, phase: { kind: 'idle', on: current.on } }, activity(state, 'response', 'response', last?.text || `${identity.name} finished.`, joined(status.footer ?? '', link)));
    case 'failed':
      return fail(state, linkedBody(status.body, link), status.keep);
  }
}

/**
 * A prepared send that has to wait behind a read of the agent: one that
 * carries only the context, to an agent that holds a text it has not
 * answered, with no request behind it. Its prepare moved the memo past what
 * the agent has said so far. An answer given since the bridge last read the
 * agent would then never be posted, and the turn would wait for a pickup
 * that does not come.
 */
export const readsFirst = (phase: RelayPhase, send: Send) => phase.working && send.prompt.length === 0 && !phase.prompt.some((reply) => !reply.superseded);

/**
 * What the read before a send of the context alone means, every time the
 * send is tried. Null while the agent has not answered: the send goes out.
 * Any other status is handled as a poll handles it. The send is then
 * dropped, and the context stays owed for the next reply.
 */
export function answered(state: SessionState, phase: RelayPhase, seen: Observed<Memo>, now: number): SessionState | null {
  if (seen.status.kind === 'working' || seen.status.kind === 'pending') return null;
  const reading = polling(phase.on, now);
  return observed({ ...state, phase: reading }, reading, seen, now);
}

/** Every wait passes through here, so the floor holds for a `Retry-After` and a backoff alike. */
export const defer = (state: SessionState, job: Job, ms: number, now: number): SessionState =>
  ({ ...state, notBefore: { ...state.notBefore, [job]: now + Math.max(MIN_WAIT_MS, ms) } });

export const succeeded = (state: SessionState, job: Job): SessionState => ({ ...state, failures: { ...state.failures, [job]: 0 } });

export type ActPhase = StartPhase | RelayPhase | PollPhase;

/** A job and the earliest time (ms epoch) it may run. The phase jobs carry the phase they act on. */
export type Due = { at: number } & (
  | { effect: 'halt'; phase: StopPhase }
  | { effect: 'retire' }
  | { effect: 'publish' }
  | { effect: 'link'; url: string }
  | { effect: 'check'; phase: PollPhase }
  | { effect: 'act'; phase: ActPhase }
);

/**
 * Every job the state calls for and the earliest time it may run, soonest
 * first. Each backend job waits only on the backend deadline, each Shortcut job
 * only on the Shortcut deadline, and retirement and the card link on their
 * own as well. Ties keep this order: a stop's halt, retirement, the
 * Shortcut jobs (the next write, the card link, the quiet-poll read), then
 * the phase's backend work. The first two need no Shortcut credentials.
 */
export function plan(state: SessionState, now: number): Due[] {
  const { phase, notBefore } = state;
  const at = (...deadlines: (number | null)[]) => Math.max(now, ...deadlines.map((deadline) => deadline ?? now));
  const due: Due[] = [];
  const on = conversationOf(phase);
  if (phase.kind === 'stop') due.push({ effect: 'halt', phase, at: at(notBefore.backend) });
  if (state.retire.length) due.push({ effect: 'retire', at: at(notBefore.backend, notBefore.retire) });
  if (state.outbox.length) due.push({ effect: 'publish', at: at(notBefore.shortcut) });
  if (on && on.url !== null && on.url !== state.linked) due.push({ effect: 'link', url: on.url, at: at(notBefore.shortcut, notBefore.link) });
  if (phase.kind === 'poll' && phase.check) due.push({ effect: 'check', phase, at: at(notBefore.shortcut, phase.at) });
  if (phase.kind === 'start' || phase.kind === 'relay') due.push({ effect: 'act', phase, at: at(notBefore.backend) });
  if (phase.kind === 'poll') due.push({ effect: 'act', phase, at: at(notBefore.backend, phase.at) });
  return due.sort((a, b) => a.at - b.at);
}

export const dueAt = (state: SessionState, now: number): number | null => plan(state, now)[0]?.at ?? null;

export function dueNow(state: SessionState, now: number): Due | null {
  const [first] = plan(state, now);
  return first && first.at <= now ? first : null;
}
