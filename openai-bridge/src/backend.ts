import { agentsClient, type Action, type AgentSession, type Turn } from './agents';
import { BackendError, type Backend, type Conversation, type Identity, type Said, type Status } from './core/port';

export const identity: Identity = { slug: 'openai-bridge', title: 'OpenAI Bridge', name: 'OpenAI', aSession: 'an OpenAI session', linkLabel: 'Open in OpenAI' };

export type BackendEnv = { OPENAI_API_KEY: string; OPENAI_AGENT_ID: string; OPENAI_ENVIRONMENT_TEMPLATE_ID?: string; OPENAI_API_BASE?: string };

/** The names `/webhook` and `/oauth/callback` require, on top of the Shortcut ones. */
export const secrets = ['OPENAI_API_KEY', 'OPENAI_AGENT_ID'] as const;

/** The function `agent.json` declares. Its `question` is the elicitation, and the reply goes back as its result. */
const ASK_TOOL = 'ask_user';

type Call = { turnId: string; callId: string };

/**
 * What places a send's answer. The API returns no id for an input it accepts,
 * and an accepted input is not in the items until the agent picks it up. So a
 * message is found by its text, and the texts of earlier messages that were
 * not in the items yet are kept, to tell them from this one.
 */
export type Memo = {
  /** The metadata key the session was opened under, so a stop reaches every session an interrupted open left under it. Null for a duplicate, which is halted alone. */
  key: string | null;
  /** The search for the input starts after this item. Null is the start of the list. Once the input is found, it is the input. */
  after: string | null;
  /** The messages sent before this send that the items after `after` have not shown yet, oldest first. */
  ahead: string[];
  /** The message this send submitted. Null until it is sent, and for an answer. */
  text: string | null;
  /** The turn of this send's input: the turn of the call for an answer, and null for a message until the items show it. */
  turn: string | null;
  /** The `ask_user` call the send answers, or null for a message. */
  answers: Call | null;
  /** The call whose question the last read showed. Only this call is answered by the next reply. */
  asked: Call | null;
  /** The calls the bridge answered that the session still listed. One is never answered or shown again. */
  answered: string[];
};

type Ask = Extract<Action, { kind: 'function' }>;

const isAsk = (action: Action): action is Ask => action.kind === 'function' && action.name === ASK_TOOL;

// The opening request is the session's first message, so the search for it starts at the first item.
const conversation = ({ id }: AgentSession, key: string | null, text: string): Conversation<Memo> => ({ id, url: null, memo: { key, after: null, ahead: [], text, turn: null, answers: null, asked: null, answered: [] } });

const lists = (session: AgentSession, callId: string) => session.actions.some((action) => action.kind === 'function' && action.callId === callId);

const rejected = (error: unknown, status: number) => error instanceof BackendError && error.failure.kind === 'rejected' && error.failure.status === status;

const failed = (body: string, keep: boolean): Status => ({ kind: 'failed', body, keep });

const SESSION_FAILED = failed('The OpenAI session failed. Reply to start a new one.', false);

// The SDK types `arguments` as `unknown`. An object is read, and a JSON string too.
function question({ arguments: args }: Ask): string {
  let value = args;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return '';
    }
  }
  return typeof value === 'object' && value !== null && 'question' in value && typeof value.question === 'string' ? value.question : '';
}

// A session that waits on something only its own app or another client can
// give cannot continue here, so it is given up and the next reply opens a new
// one. Giving it up cancels the waiting turn.
function unanswerable(action: Action): Status {
  const end = 'Reply to start a new one.';
  if (action.kind === 'function') {
    const name = /^[A-Za-z0-9_-]{1,64}$/.test(action.name) ? `the function ${action.name}` : 'a function';
    return failed(`OpenAI called ${name}, which the bridge does not run. ${end}`, false);
  }
  if (action.type === 'environment_connection') return failed(`OpenAI is waiting for an environment connection the bridge cannot make. ${end}`, false);
  return failed(`OpenAI is waiting for an approval the bridge cannot give. ${end}`, false);
}

function outcome(turn: Turn): Status {
  switch (turn.status) {
    case 'completed': return { kind: 'finished' };
    case 'cancelled': return failed('The OpenAI turn was cancelled. Reply to try again.', true);
    case 'failed':
      if (turn.code === 'active_turn_not_steerable') return failed('OpenAI could not take your reply while it was working. Reply to try again.', true);
      return failed(`The OpenAI turn failed${turn.code ? ` (${turn.code})` : ''}. Reply to try again.`, true);
    default: return { kind: 'working' };
  }
}

export function connect(env: BackendEnv): Backend<Memo> {
  const agents = agentsClient({ apiKey: env.OPENAI_API_KEY, baseUrl: env.OPENAI_API_BASE });
  const template = env.OPENAI_ENVIRONMENT_TEMPLATE_ID?.trim();
  const environment = template ? { type: 'openai_hosted' as const, environment_template_id: template } : { type: 'none' as const };

  // Cancelling stops the turn and keeps the session. A 202 says only that the
  // cancel was accepted, and a 409 only that the session's state conflicts
  // with it, so the session is read to learn whether the work stopped.
  async function stop(id: string): Promise<'idle' | 'gone' | 'working'> {
    try {
      await agents.submit(id, { type: 'agent.session.input.cancel' }).catch((error: unknown) => {
        if (!rejected(error, 409)) throw error;
      });
      const { status } = await agents.getSession(id);
      return status === 'idle' ? 'idle' : status === 'failed' ? 'gone' : 'working';
    } catch (error) {
      if (rejected(error, 404)) return 'gone';
      throw error;
    }
  }

  // What a session that waits on nothing the bridge has to show is doing.
  // One that still requires action lists only calls the bridge answered, so
  // the agent has not picked the answer up yet.
  async function progress(session: AgentSession, { turn }: Memo): Promise<Status> {
    if (session.status === 'requires_action') return { kind: 'pending' };
    if (session.status !== 'idle') return { kind: 'working' };
    return turn === null ? { kind: 'pending' } : outcome(await agents.getTurn(session.id, turn));
  }

  // Looks for the send's message among the items after the cursor. A user
  // message with the text of an earlier send is that send's. The first other
  // one with this send's text is this send's. What was read is not read
  // again: the cursor moves to the message, or to the last item read.
  async function place(id: string, memo: Memo): Promise<Memo> {
    const { items, last } = await agents.listItems(id, memo.after);
    const ahead = [...memo.ahead];
    for (const item of items) {
      if (item.kind !== 'message') continue;
      const earlier = ahead.indexOf(item.text);
      if (earlier >= 0) ahead.splice(earlier, 1);
      else if (item.text === memo.text) return { ...memo, after: item.id, ahead, turn: item.turnId };
    }
    return { ...memo, after: last ?? memo.after, ahead };
  }

  // The agent's newest message since the input, if it has one. The core posts
  // only the newest, and reading the turn newest first finds it however long
  // the turn is. An item the bridge cannot read may be a newer message, so
  // nothing older than it is taken.
  async function newest(id: string, turnId: string, { answers }: Memo): Promise<Said[]> {
    for await (const item of agents.turnItems(id, turnId)) {
      if (item === null) return [];
      if (item.kind === 'said') return [{ id: item.id, text: item.text }];
      if (answers ? item.kind === 'call' && item.callId === answers.callId : item.kind === 'message') return [];
    }
    return [];
  }

  return {
    // The create carries the text, because `input` is required when the
    // environment is `none`. A create lost to a crash is looked up by its
    // metadata key.
    async open({ key, text }) {
      const [adopted, ...duplicates] = await agents.findSessions(key);
      const session = adopted ?? (await agents.createSession({ agentId: env.OPENAI_AGENT_ID, environment, input: text, key }));
      return { conversation: conversation(session, key, text), delivered: true, duplicates: duplicates.map((duplicate) => conversation(duplicate, null, text)) };
    },

    // The reply answers a question only when the user was shown it and its
    // call is still pending. Any other reply goes as a message, and `observe`
    // then shows whatever question the session waits on.
    async prepare({ id, memo }) {
      let session: AgentSession;
      try {
        session = await agents.getSession(id);
      } catch (error) {
        if (rejected(error, 404)) return { kind: 'gone', empty: false };
        throw error;
      }
      if (session.status === 'failed') return { kind: 'gone', empty: false };
      const answered = memo.answered.filter((callId) => lists(session, callId));
      const answers = memo.asked && lists(session, memo.asked.callId) ? memo.asked : null;
      // While an earlier message is not placed, the search starts where its search started.
      const ahead = memo.turn === null && memo.text !== null ? [...memo.ahead, memo.text] : memo.ahead;
      const after = ahead.length ? memo.after : await agents.newestItem(id);
      return { kind: 'ready', empty: false, memo: { ...memo, after, ahead, text: null, turn: answers?.turnId ?? null, answers, asked: null, answered } };
    },

    async send({ id, memo }, { text, key }) {
      const { answers } = memo;
      if (answers === null) {
        await agents.submit(id, { type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text }] }] }, key);
        return { ...memo, text };
      }
      // A retried send repeats the result only while its call is still pending, which the function tools guide allows.
      // The key goes with it as the SDK's tool dispatcher sends it, though the API documents the key for messages only.
      if (lists(await agents.getSession(id), answers.callId)) {
        await agents.submit(id, { type: 'agent.session.input.tool_result', turn_id: answers.turnId, call_id: answers.callId, success: true, output: text }, key);
      }
      return { ...memo, answered: [...memo.answered, answers.callId] };
    },

    // The session is read before the items, so an outcome never misses the
    // message that came with it. What the session waits on comes before the
    // send's own turn: it blocks the session whether or not the agent has
    // picked the send up. Until the items show the send's message, the
    // session still describes the turn before, and an idle session proves
    // nothing.
    async observe({ id, memo }) {
      const session = await agents.getSession(id);
      if (session.status === 'failed') return { memo, said: [], status: SESSION_FAILED };
      const placed = memo.turn === null ? await place(id, memo) : memo;
      const waiting = session.actions.filter((action) => !(action.kind === 'function' && memo.answered.includes(action.callId)));
      const blocker = waiting.find((action) => !isAsk(action));
      if (blocker) return { memo: placed, said: [], status: unanswerable(blocker) };
      const ask = waiting.find(isAsk);
      if (ask) return { memo: { ...placed, asked: { turnId: ask.turnId, callId: ask.callId } }, said: [{ id: ask.callId, text: question(ask) }], status: { kind: 'asked', on: 'user' } };
      const said = placed.turn === null ? [] : await newest(id, placed.turn, placed);
      return { memo: placed, said, status: await progress(session, placed) };
    },

    // Stops the conversation and every other session under its key: a create
    // whose answer was lost can leave one the open's lookup did not show yet.
    // A session that still works fails the call, so the core cancels again
    // until all have stopped or the budget of the stop is spent.
    async halt(target) {
      const own = target.kind === 'live' ? target.conversation : null;
      const key = target.kind === 'live' ? target.conversation.memo.key : target.key;
      const states = own ? [await stop(own.id)] : [];
      for (const { id } of key === null ? [] : await agents.findSessions(key)) if (id !== own?.id) states.push(await stop(id));
      if (states.includes('working')) throw new BackendError({ kind: 'transient' });
      if (own) return states[0] === 'idle' ? { kind: 'kept' } : { kind: 'ended', url: null };
      return states.length ? { kind: 'ended', url: null } : { kind: 'unseen' };
    },
  };
}
