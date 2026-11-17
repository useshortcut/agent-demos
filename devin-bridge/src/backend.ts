import { devinClient, type DevinMessage, type DevinSession, type DevinState } from './devin';
import { BackendError, type Backend, type Conversation, type Identity, type Said, type Status } from './core/port';

export { upgradeState } from './upgrade';

export const identity: Identity = { slug: 'devin-bridge', title: 'Devin Bridge', name: 'Devin', aSession: 'a Devin session', linkLabel: 'Open in Devin' };

export type BackendEnv = { DEVIN_API_KEY: string; DEVIN_ORG_ID: string; DEVIN_API_BASE?: string };

/** The names `/webhook` and `/oauth/callback` require, on top of the Shortcut ones. */
export const secrets = ['DEVIN_API_KEY', 'DEVIN_ORG_ID'] as const;

/** What Devin showed before a reply was sent. Until Devin acts on the reply, its status still describes the previous turn. */
type Baseline = { last: string | null; status: DevinState };

/** Null until a reply is relayed: everything a new session says is fresh. `prompt` is the text sent, null between `prepare` and `send`. */
export type Memo = { baseline: Baseline; prompt: string | null; heard: boolean } | null;

const isFinal = (state: DevinState) => state.kind === 'failed' && state.cause !== 'suspended';

const sameState = (a: DevinState, b: DevinState) => JSON.stringify(a) === JSON.stringify(b);

// Devin's app renders [NAME]…[/NAME] as UI, such as a button, and Shortcut would show the tags as written.
const UI_MARKUP = /\[([A-Z_]+)\]([\s\S]*?)\[\/\1\]/g;

function unmarked(text: string): string {
  const inner = text.replace(UI_MARKUP, '$2');
  return inner === text ? text : unmarked(inner);
}

const devins = (list: DevinMessage[]) => list.filter((m) => m.source === 'devin').map((m) => ({ id: m.id, text: unmarked(m.body) }));

// What Devin said after the relayed reply, so the previous turn's answer never becomes this turn's.
function spoken(messages: DevinMessage[], memo: Memo): Said[] {
  if (memo === null) return devins(messages);
  const { last } = memo.baseline;
  const at = last === null ? -1 : messages.findIndex((m) => m.id === last);
  if (last !== null && at < 0) return [];
  const after = messages.slice(at + 1);
  const exact = after.findIndex((m) => m.source !== 'devin' && m.body === memo.prompt);
  const reply = exact >= 0 ? exact : after.findIndex((m) => m.source !== 'devin');
  return reply < 0 ? [] : devins(after.slice(reply + 1));
}

function statusOf({ state, pullRequests }: DevinSession): Status {
  switch (state.kind) {
    case 'working': return { kind: 'working' };
    case 'waiting': return { kind: 'asked', on: state.on };
    case 'finished': return pullRequests.length ? { kind: 'finished', footer: `Pull requests:\n${pullRequests.map((pr) => `- ${pr}`).join('\n')}` } : { kind: 'finished' };
    case 'failed':
      if (state.cause === 'suspended') return { kind: 'failed', body: `The Devin session stopped: suspended (${state.reason}). Reply to wake it.`, keep: true };
      return { kind: 'failed', body: `${state.cause === 'error' ? 'The Devin session ended with an error.' : 'The Devin session was terminated in Devin.'} Reply to start a new one.`, keep: false };
  }
}

const conversation = ({ id, url }: DevinSession): Conversation<Memo> => ({ id, url, memo: null });

// Only a session that is already gone answers one of these.
const GONE = new Set([404, 409, 410]);

export function connect(env: BackendEnv): Backend<Memo> {
  const devin = devinClient({ apiKey: env.DEVIN_API_KEY, orgId: env.DEVIN_ORG_ID, baseUrl: env.DEVIN_API_BASE });

  async function terminate(id: string): Promise<void> {
    try {
      await devin.terminate(id);
    } catch (error) {
      if (!(error instanceof BackendError && error.failure.kind === 'rejected' && GONE.has(error.failure.status))) throw error;
    }
  }

  return {
    // Devin has no idempotency key, so the key is a tag: a retried open adopts the session an interrupted one created.
    async open({ key, title, text }) {
      const [adopted, ...duplicates] = await devin.findSessionsByTag(key);
      const session = adopted ?? (await devin.createSession(text, title, key));
      return { conversation: conversation(session), delivered: true, duplicates: duplicates.map(conversation) };
    },

    // A Devin session is created with its prompt, so it is never empty.
    async prepare({ id }) {
      const session = await devin.getSession(id);
      if (isFinal(session.state)) return { kind: 'gone', empty: false };
      const { messages } = await devin.listMessages(id);
      return { kind: 'ready', empty: false, memo: { baseline: { last: messages[messages.length - 1]?.id ?? null, status: session.state }, prompt: null, heard: false } };
    },

    async send({ id, memo }, { text }) {
      await devin.sendMessage(id, text);
      return memo && { ...memo, prompt: text };
    },

    async observe({ id, memo }) {
      const session = await devin.getSession(id);
      const { messages, complete } = await devin.listMessages(id);
      if (!complete) console.warn('Devin Bridge read a cut-short Devin message list', { devinSessionId: id });
      const said = complete ? spoken(messages, memo) : [];
      if (memo && !memo.heard && said.length === 0 && sameState(memo.baseline.status, session.state)) {
        return { memo, said, status: session.state.kind === 'working' ? { kind: 'working' } : { kind: 'pending' } };
      }
      return { memo: memo && { ...memo, heard: true }, said, status: statusOf(session) };
    },

    async halt(target) {
      if (target.kind === 'live') {
        await terminate(target.conversation.id);
        return { kind: 'ended', url: target.conversation.url };
      }
      const found = await devin.findSessionsByTag(target.key);
      for (const session of found) await terminate(session.id);
      return found.length ? { kind: 'ended', url: found[0].url } : { kind: 'unseen' };
    },
  };
}
