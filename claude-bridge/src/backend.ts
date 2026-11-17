import Anthropic, { AnthropicError, APIError } from '@anthropic-ai/sdk';
import type { BetaManagedAgentsEventParams, BetaManagedAgentsSessionEventType, EventListParams } from '@anthropic-ai/sdk/resources/beta/sessions/events';
import { BackendError, failureOf, type Backend, type Conversation, type Identity, type Observed, type Status } from './core/port';

export const identity: Identity = { slug: 'claude-bridge', title: 'Claude Bridge', name: 'Claude', aSession: 'a Claude session', linkLabel: 'Open in Claude Console' };

export type BackendEnv = {
  ANTHROPIC_API_KEY: string;
  CLAUDE_AGENT_ID: string;
  CLAUDE_ENVIRONMENT_ID: string;
  CLAUDE_CONSOLE_WORKSPACE_ID?: string;
  ANTHROPIC_API_BASE?: string;
};

export const secrets = ['ANTHROPIC_API_KEY', 'CLAUDE_AGENT_ID', 'CLAUDE_ENVIRONMENT_ID'] as const;

export type Memo = {
  /** The event the last send created. What the agent did after it is the current turn. */
  anchor: string | null;
  /** `processed_at` of the newest idle read that waits on no call. Each poll lists events from here, so a long session is not re-read from its start and the calls an idle still names stay in the list. */
  mark: string | null;
  /** The `ask_user` call whose question the user was shown and has not answered. The next send is its result. */
  asked: string | null;
};

/** The custom tool `agent.json` declares. Its `question` input is the elicitation. */
const ASK_TOOL = 'ask_user';

const REQUEST_TIMEOUT_MS = 15_000;
const EVENT_PAGE_SIZE = 1000;
const MAX_EVENT_PAGES = 10;
/** How many of the newest events of its types a lookup reads: tool results for one an earlier attempt landed, status and call events for a call the session waits on, and sent events for the last one. */
const LOOKUP = 20;
// Assumed: a session that is gone answers an interrupt with one of these, and no other session does.
const GONE = new Set([404, 409, 410]);

const TURN_EVENTS: BetaManagedAgentsSessionEventType[] = [
  'user.message', 'user.custom_tool_result', 'agent.message', 'agent.custom_tool_use',
  'session.status_running', 'session.status_idle', 'session.status_terminated',
];

/** What the bridge reads from the event list. */
type Event =
  | { kind: 'input'; id: string; processed: boolean; answers: string | null }
  | { kind: 'said'; id: string; text: string }
  | { kind: 'call'; id: string; name: string; question: string }
  | { kind: 'working'; id: string }
  | { kind: 'idle'; id: string; at: string; reason: string; on: string[]; category: string | null }
  | { kind: 'terminated'; id: string }
  | { kind: 'other'; id: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const named = (value: unknown) => (typeof value === 'string' && NAME.test(value) ? value : null);

function parseEvent(value: unknown): Event {
  if (!isRecord(value) || typeof value.id !== 'string') throw new BackendError({ kind: 'transient' });
  const { id } = value;
  switch (value.type) {
    case 'user.message':
    case 'user.custom_tool_result':
      return { kind: 'input', id, processed: typeof value.processed_at === 'string', answers: typeof value.custom_tool_use_id === 'string' ? value.custom_tool_use_id : null };
    case 'agent.message': {
      const blocks = Array.isArray(value.content) ? value.content : [];
      return { kind: 'said', id, text: blocks.flatMap((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('') };
    }
    case 'agent.custom_tool_use': {
      const question = isRecord(value.input) && typeof value.input.question === 'string' ? value.input.question : '';
      return { kind: 'call', id, name: typeof value.name === 'string' ? value.name : '', question };
    }
    case 'session.status_running':
      return { kind: 'working', id };
    case 'session.status_terminated':
      return { kind: 'terminated', id };
    case 'session.status_idle': {
      const reason = isRecord(value.stop_reason) ? value.stop_reason : {};
      const on = Array.isArray(reason.event_ids) ? reason.event_ids.filter((e): e is string => typeof e === 'string') : [];
      const category = isRecord(value.stop_details) ? named(value.stop_details.category) : null;
      return { kind: 'idle', id, at: typeof value.processed_at === 'string' ? value.processed_at : '', reason: named(reason.type) ?? 'unknown', on, category };
    }
    default:
      return { kind: 'other', id };
  }
}

type Call = Extract<Event, { kind: 'call' }>;

/** What an `ask_user` call is told when the user's message crossed its question. */
const crossed = (text: string) => `The user has not seen this question. They sent this message before it reached them:\n\n${text}\n\nAsk again if you still need an answer.`;

const TERMINATED: Status = { kind: 'failed', body: 'The Claude session was terminated. Reply to start a new one.', keep: false };

/** What an idle session that waits on no call tells Shortcut. */
function stoppedFor(idle: Extract<Event, { kind: 'idle' }>): Status {
  switch (idle.reason) {
    case 'end_turn': return { kind: 'finished' };
    case 'retries_exhausted': return { kind: 'failed', body: 'The Claude session stopped after it ran out of retries. Reply to start a new one.', keep: false };
    case 'refusal': return { kind: 'failed', body: `Claude declined to continue${idle.category ? ` (${idle.category})` : ''}. Reply to try again.`, keep: true };
    default: return { kind: 'failed', body: `The Claude session stopped (${idle.reason}). Reply to try again.`, keep: true };
  }
}

/** A session that waits on a call takes only that call's answer, and the bridge has none to give, so the next reply needs a new session. */
function blocked(call: Call | undefined): Status {
  const tool = call && named(call.name);
  return call
    ? { kind: 'failed', body: `The Claude session called ${tool ? `the custom tool \`${tool}\`` : 'a custom tool'}, which Claude Bridge cannot run. Reply to start a new session.`, keep: false }
    : { kind: 'failed', body: 'The Claude session is waiting for a tool call to be approved, and Claude Bridge cannot approve one. Give the agent\'s tools a permission policy that needs no confirmation, then reply to start a new session.', keep: false };
}

/** Whether the agent has started on the event the last send created. A queued event has no `processed_at`, or is not in the list at all. */
const taken = (events: Event[], anchor: string | null) => anchor === null || events.some((e) => e.id === anchor && e.kind === 'input' && e.processed);

const lastStatus = (events: Event[]) => events.filter((e) => e.kind === 'working' || e.kind === 'idle').at(-1);

/** The current turn, read from what came after the anchor. */
function turnOf(events: Event[], memo: Memo): Observed<Memo> {
  const terminated = events.some((e) => e.kind === 'terminated');
  // Until the agent takes the message, the list shows the turn before. While that turn runs, the message is in line behind it.
  if (!taken(events, memo.anchor)) return { memo, said: [], status: terminated ? TERMINATED : { kind: lastStatus(events)?.kind === 'working' ? 'working' : 'pending' } };
  const after = events.slice(events.findIndex((e) => e.id === memo.anchor) + 1);
  const said = after.flatMap((e) => (e.kind === 'said' && e.text ? [{ id: e.id, text: e.text }] : []));
  const last = lastStatus(after);
  // The answer of a turn that finished stands when the session was terminated after it.
  if (terminated && !(last?.kind === 'idle' && last.reason === 'end_turn')) return { memo, said, status: TERMINATED };
  if (last?.kind !== 'idle') return { memo, said, status: { kind: 'working' } };
  if (last.reason !== 'requires_action') return { memo: { ...memo, mark: last.at || memo.mark }, said, status: stoppedFor(last) };
  // A call can be older than the anchor: answering one of several leaves the session waiting on the rest.
  const calls = events.filter((e): e is Call => e.kind === 'call' && last.on.includes(e.id));
  const question = calls.find((call) => call.name === ASK_TOOL);
  if (!question) return { memo, said, status: blocked(calls[0]) };
  return { memo: { ...memo, asked: question.id }, said: [...said, { id: question.id, text: question.question }], status: { kind: 'asked', on: 'user' } };
}

export function connect(env: BackendEnv): Backend<Memo> {
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: env.ANTHROPIC_API_BASE || 'https://api.anthropic.com',
    maxRetries: 0,
    logLevel: 'off',
  });
  const { sessions } = client.beta;
  const workspace = env.CLAUDE_CONSOLE_WORKSPACE_ID?.trim();

  // One request. The SDK's own timeout ends when the response headers arrive, so this deadline is the one that covers the body.
  async function call<T>(request: string, claudeSessionId: string | null, run: (bound: { signal: AbortSignal }) => Promise<T>): Promise<T> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await run({ signal: deadline.signal });
    } catch (error) {
      if (error instanceof APIError && typeof error.status === 'number') {
        console.error('Claude request rejected', { request, claudeSessionId, status: error.status });
        throw new BackendError(failureOf(error.status, error.headers?.get('Retry-After') ?? null, Date.now()));
      }
      // A body cut off at the deadline fails with the runtime's error, not one of the SDK's.
      if (!(error instanceof AnthropicError) && !deadline.signal.aborted) throw error;
      console.error('Claude request failed', { request, claudeSessionId, timeoutMs: REQUEST_TIMEOUT_MS });
      throw new BackendError({ kind: 'transient' });
    } finally {
      clearTimeout(timer);
    }
  }

  const newest = async (id: string, types: BetaManagedAgentsSessionEventType[], limit: number) =>
    (await call('events.list', id, (bound) => sessions.events.list(id, { types, order: 'desc', limit }, bound))).data.map(parseEvent);

  async function turnEvents(id: string, since: string | null): Promise<{ events: Event[]; complete: boolean }> {
    const events: Event[] = [];
    let cursor: string | null = null;
    for (let pages = 1; ; pages++) {
      const query: EventListParams = { types: TURN_EVENTS, order: 'asc', limit: EVENT_PAGE_SIZE, ...(since ? { 'created_at[gte]': since } : {}), ...(cursor ? { page: cursor } : {}) };
      const page = await call('events.list', id, (bound) => sessions.events.list(id, query, bound));
      events.push(...page.data.map(parseEvent));
      if (!page.next_page) return { events, complete: true };
      if (pages === MAX_EVENT_PAGES) return { events, complete: false };
      cursor = page.next_page;
    }
  }

  async function post(id: string, event: BetaManagedAgentsEventParams): Promise<string> {
    const sent = await call('events.send', id, (bound) => sessions.events.send(id, { events: [event] }, bound));
    const created = sent.data?.[0]?.id;
    if (typeof created !== 'string' || created === '') throw new BackendError({ kind: 'transient' });
    return created;
  }

  // The newest status event says whether the session waits, and its stop reason on which calls.
  async function waitingQuestion(id: string): Promise<string | null> {
    const recent = await newest(id, ['session.status_running', 'session.status_idle', 'agent.custom_tool_use'], LOOKUP);
    const status = recent.find((e) => e.kind === 'working' || e.kind === 'idle');
    if (status?.kind !== 'idle') return null;
    return recent.find((e) => e.kind === 'call' && e.name === ASK_TOOL && status.on.includes(e.id))?.id ?? null;
  }

  return {
    // No `initial_events`: the session is created idle and starts no work, so
    // one lost to a crash costs nothing and needs no lookup. The create has no
    // idempotency key and the session list no metadata filter.
    async open({ key, title }) {
      const session = await call('sessions.create', null, (bound) =>
        sessions.create({ agent: env.CLAUDE_AGENT_ID, environment_id: env.CLAUDE_ENVIRONMENT_ID, title, metadata: { shortcut_session: key } }, bound));
      if (typeof session?.id !== 'string') throw new BackendError({ kind: 'transient' });
      const url = workspace ? `https://platform.claude.com/workspaces/${encodeURIComponent(workspace)}/sessions/${encodeURIComponent(session.id)}` : null;
      const conversation: Conversation<Memo> = { id: session.id, url, memo: { anchor: null, mark: null, asked: null } };
      return { conversation, delivered: false, duplicates: [] };
    },

    // Whether the session holds a message is looked up only while no send was confirmed.
    async prepare({ id, memo }) {
      const session = await call('sessions.retrieve', id, (bound) => sessions.retrieve(id, {}, bound));
      const empty = memo.anchor === null && (await newest(id, ['user.message'], 1)).length === 0;
      return session.status === 'terminated' ? { kind: 'gone', empty } : { kind: 'ready', empty, memo };
    },

    // The reply to a question the user was shown is that call's result. A
    // result is processed on receipt, so one an earlier attempt landed is in
    // the list. It is adopted: a second result for a call is accepted and has
    // no effect, and an anchor on it would have nothing of the turn after it.
    //
    // Any other reply is a message. A session that waits on a call takes
    // only results, so when it waits on a question the user never saw, the
    // message goes as that call's result, worded so that it is no answer. A
    // message has no idempotency key, so a step that dies after it sends twice.
    async send({ id, memo }, { text }) {
      const result = (toolUseId: string, said: string) => post(id, { type: 'user.custom_tool_result', custom_tool_use_id: toolUseId, content: [{ type: 'text', text: said }] });
      if (memo.asked !== null) {
        const results = await newest(id, ['user.custom_tool_result'], LOOKUP);
        const landed = results.find((e) => e.kind === 'input' && e.answers === memo.asked);
        return { ...memo, asked: null, anchor: landed?.id ?? (await result(memo.asked, text)) };
      }
      const unseen = await waitingQuestion(id);
      return { ...memo, anchor: unseen ? await result(unseen, crossed(text)) : await post(id, { type: 'user.message', content: [{ type: 'text', text }] }) };
    },

    async observe({ id, memo }) {
      const { events, complete } = await turnEvents(id, memo.mark);
      if (!complete) {
        console.warn('Claude Bridge read a cut-short Claude event list', { claudeSessionId: id });
        return { memo, said: [], status: { kind: 'failed', body: 'The Claude session has more events than Claude Bridge reads. Reply to start a new one.', keep: false } };
      }
      return turnOf(events, memo);
    },

    // An unresolved open delivered no text, so whatever it made is idle and
    // needs no call. An interrupt jumps the queue, so a message still queued
    // runs after it. The halt then fails, and the retry the core gives it
    // interrupts the turn that message started.
    async halt(target) {
      if (target.kind === 'unresolved') return { kind: 'ended', url: null };
      const { id, memo } = target.conversation;
      try {
        const queued = !taken(await newest(id, ['user.message', 'user.custom_tool_result'], LOOKUP), memo.anchor);
        await call('events.send', id, (bound) => sessions.events.send(id, { events: [{ type: 'user.interrupt' }] }, bound));
        if (queued) throw new BackendError({ kind: 'transient' });
        return { kind: 'kept' };
      } catch (error) {
        if (error instanceof BackendError && error.failure.kind === 'rejected' && GONE.has(error.failure.status)) return { kind: 'ended', url: null };
        throw error;
      }
    },
  };
}
