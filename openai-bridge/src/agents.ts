import OpenAI, { APIError } from 'openai';
import type { AgentSessionInputParam, EnvironmentParam } from 'openai/resources/beta/agents/agents';
import { BackendError, failureOf } from './core/port';

export type AgentsConfig = { apiKey: string; baseUrl?: string };

export type SessionStatus = 'idle' | 'in_progress' | 'requires_action' | 'failed';

/** What a session waits on. */
export type Action =
  | { kind: 'function'; turnId: string; callId: string; name: string; arguments: unknown }
  | { kind: 'other'; type: string };

export type AgentSession = { id: string; status: SessionStatus; actions: Action[] };

export type Item =
  | { kind: 'message'; id: string; turnId: string; text: string }
  | { kind: 'call'; callId: string }
  | { kind: 'said'; id: string; text: string }
  | { kind: 'other' };

export type TurnStatus = 'queued' | 'in_progress' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export type Turn = { status: TurnStatus; code: string | null };

const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;
const MAX_ITEM_PAGES = 10;
const MAX_SESSION_PAGES = 5;
const SESSION_METADATA_KEY = 'shortcut_session';

const SESSION_STATUSES = new Set<string>(['idle', 'in_progress', 'requires_action', 'failed']);
const TURN_STATUSES = new Set<string>(['queued', 'in_progress', 'waiting', 'completed', 'failed', 'cancelled']);
const IDENTIFIER = /^[a-z_]{1,64}$/;

const isSessionStatus = (status: string): status is SessionStatus => SESSION_STATUSES.has(status);
const isTurnStatus = (status: string): status is TurnStatus => TURN_STATUSES.has(status);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function parseAction(value: unknown): Action {
  if (!isRecord(value)) return { kind: 'other', type: 'unknown' };
  const { type, turn_id: turnId, call_id: callId, name } = value;
  if (type === 'function_call' && typeof turnId === 'string' && typeof callId === 'string' && typeof name === 'string') {
    return { kind: 'function', turnId, callId, name, arguments: value.arguments };
  }
  return { kind: 'other', type: typeof type === 'string' ? type : 'unknown' };
}

// A status the bridge does not know counts as in progress, so it keeps polling.
function parseSession(value: unknown): AgentSession {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.status !== 'string') throw new BackendError({ kind: 'transient' });
  const status = isSessionStatus(value.status) ? value.status : 'in_progress';
  return { id: value.id, status, actions: Array.isArray(value.required_actions) ? value.required_actions.map(parseAction) : [] };
}

// Null is an item the bridge cannot read. A message still being written is
// read once it is complete.
function parseItem(value: unknown): Item | null {
  if (!isRecord(value)) return null;
  const { type, role, id, turn_id: turnId, call_id: callId, content, status } = value;
  if (typeof type !== 'string') return null;
  if (type === 'function_call') return typeof callId === 'string' ? { kind: 'call', callId } : null;
  if (type !== 'message') return { kind: 'other' };
  if (typeof id !== 'string' || !Array.isArray(content)) return null;
  const text = (part: string) => content.flatMap((each) => (isRecord(each) && each.type === part && typeof each.text === 'string' ? [each.text] : [])).join('\n\n');
  if (role === 'user') return typeof turnId === 'string' ? { kind: 'message', id, turnId, text: text('input_text') } : null;
  if (role !== 'assistant' || status !== 'completed') return { kind: 'other' };
  return { kind: 'said', id, text: text('output_text') };
}

// `instanceof` types a generic class's arguments as `any`. This narrows to the SDK's error with the types it declares.
const isApiError = (error: unknown): error is APIError => error instanceof APIError;

export function agentsClient({ apiKey, baseUrl = 'https://api.openai.com/v1' }: AgentsConfig) {
  // The SDK's own retries would hide failures from the core's budget, and its logs could carry response bodies.
  const openai = new OpenAI({ apiKey, baseURL: baseUrl, maxRetries: 0, timeout: REQUEST_TIMEOUT_MS, logLevel: 'off', fetch: (input, init) => fetch(input, init) });
  const sessions = openai.beta.agents.sessions;

  async function call<T>(name: string, run: () => PromiseLike<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (isApiError(error) && typeof error.status === 'number') {
        console.error('OpenAI request rejected', { call: name, status: error.status });
        throw new BackendError(failureOf(error.status, error.headers?.get('Retry-After') ?? null, Date.now()));
      }
      console.error('OpenAI request failed', { call: name, timeoutMs: REQUEST_TIMEOUT_MS });
      throw new BackendError({ kind: 'transient' });
    }
  }

  // The pages of a list, up to `max` of them.
  async function* pages<P extends { hasNextPage(): boolean; getNextPage(): Promise<P> }>(name: string, first: () => PromiseLike<P>, max: number): AsyncGenerator<P> {
    let page = await call(name, first);
    for (let read = 1; ; read++) {
      yield page;
      if (read === max || !page.hasNextPage()) return;
      const current = page;
      page = await call(name, () => current.getNextPage());
    }
  }

  return {
    async createSession({ agentId, environment, input, key }: { agentId: string; environment: EnvironmentParam; input: string; key: string }): Promise<AgentSession> {
      return parseSession(await call('sessions.create', () => sessions.create({ agent_id: agentId, environment, input, metadata: { [SESSION_METADATA_KEY]: key } })));
    },

    // The filter is eventually consistent, so a session created a moment ago
    // can be missing. The key is checked on what comes back, so a server that
    // ignores the filter cannot make the bridge adopt the wrong session. Oldest
    // first, so a caller adopts the one an earlier attempt made. A lookup
    // whose last page read says there are more fails, so no caller takes the
    // sessions it read for all of them.
    async findSessions(key: string): Promise<AgentSession[]> {
      const found: AgentSession[] = [];
      let more = false;
      for await (const page of pages('sessions.list', () => sessions.list({ metadata: { [SESSION_METADATA_KEY]: key }, order: 'asc', limit: PAGE_SIZE }), MAX_SESSION_PAGES)) {
        for (const session of page.data) if (isRecord(session) && isRecord(session.metadata) && session.metadata[SESSION_METADATA_KEY] === key) found.push(parseSession(session));
        more = page.has_more;
      }
      if (!more) return found;
      console.warn('OpenAI Bridge could not read every session under a key', { key });
      throw new BackendError({ kind: 'transient' });
    },

    async getSession(id: string): Promise<AgentSession> {
      return parseSession(await call('sessions.retrieve', () => sessions.retrieve(id)));
    },

    // The bridge asks only once the items hold a message of its own. Only a
    // legacy user message has no id, and the sessions this bridge creates
    // have none.
    async newestItem(id: string): Promise<string> {
      const page = await call('sessions.items.list', () => sessions.items.list(id, { order: 'desc', limit: 1 }));
      const [newest] = page.data;
      if (!isRecord(newest) || typeof newest.id !== 'string') throw new BackendError({ kind: 'transient' });
      return newest.id;
    },

    // The items the bridge can read among the first 1,000 after `after`,
    // oldest first. `last` is the last item read, where a later call goes on.
    async listItems(id: string, after: string | null): Promise<{ items: Item[]; last: string | null }> {
      const items: Item[] = [];
      let last: string | null = null;
      for await (const page of pages('sessions.items.list', () => sessions.items.list(id, { order: 'asc', limit: PAGE_SIZE, ...(after ? { after } : {}) }), MAX_ITEM_PAGES)) {
        for (const value of page.data) {
          const item = parseItem(value);
          if (item) items.push(item);
          if (isRecord(value) && typeof value.id === 'string') last = value.id;
        }
      }
      return { items, last };
    },

    // The newest 1,000 items of one turn, newest first, a page at a time as the caller reads on.
    async *turnItems(sessionId: string, turnId: string): AsyncGenerator<Item | null> {
      for await (const page of pages('sessions.turns.items.list', () => sessions.turns.items.list(turnId, { session_id: sessionId, order: 'desc', limit: PAGE_SIZE }), MAX_ITEM_PAGES)) {
        for (const value of page.data) yield parseItem(value);
      }
    },

    async getTurn(sessionId: string, turnId: string): Promise<Turn> {
      const turn: unknown = await call('sessions.turns.retrieve', () => sessions.turns.retrieve(turnId, { session_id: sessionId }));
      if (!isRecord(turn) || typeof turn.status !== 'string') throw new BackendError({ kind: 'transient' });
      const code = isRecord(turn.error) && typeof turn.error.code === 'string' && IDENTIFIER.test(turn.error.code) ? turn.error.code : null;
      return { status: isTurnStatus(turn.status) ? turn.status : 'in_progress', code };
    },

    async submit(id: string, event: AgentSessionInputParam, key?: string): Promise<void> {
      await call('sessions.events.create', () => sessions.events.create(id, { events: [event], ...(key ? { 'Idempotency-Key': key } : {}) }));
    },
  };
}

export type AgentsClient = ReturnType<typeof agentsClient>;
