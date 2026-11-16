import { devinClient, type DevinMessage, type DevinSession, type DevinState } from './devin';
import type { Backend, Status } from './port';

export type BackendEnv = { DEVIN_API_KEY: string; DEVIN_ORG_ID: string; DEVIN_API_BASE?: string };

/** What Devin showed before a reply was sent. Until Devin acts on the reply, its status still describes the previous turn. */
type Baseline = { last: string | null; status: DevinState };

/** Null until a reply is relayed: everything a new session says is fresh. `prompt` is the text sent, null between `prepare` and `send`. */
export type Memo = { baseline: Baseline; prompt: string | null; heard: boolean } | null;

export const isFinal = (state: DevinState) => state.kind === 'failed' && state.cause !== 'suspended';

const sameState = (a: DevinState, b: DevinState) => JSON.stringify(a) === JSON.stringify(b);

// Devin's app renders [NAME]…[/NAME] as UI, such as a button, and Shortcut would show the tags as written.
const UI_MARKUP = /\[([A-Z_]+)\]([\s\S]*?)\[\/\1\]/g;

function unmarked(text: string): string {
  const inner = text.replace(UI_MARKUP, '$2');
  return inner === text ? text : unmarked(inner);
}

// What Devin said after the relayed reply, so the previous turn's answer never becomes this turn's.
function spoken(messages: DevinMessage[], memo: Memo): DevinMessage[] {
  const devins = (list: DevinMessage[]) => list.filter((m) => m.source === 'devin').map((m) => ({ ...m, body: unmarked(m.body) }));
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

export function connect(env: BackendEnv): Pick<Backend<Memo>, 'observe'> {
  const devin = devinClient({ apiKey: env.DEVIN_API_KEY, orgId: env.DEVIN_ORG_ID, baseUrl: env.DEVIN_API_BASE });
  return {
    async observe({ id, memo }) {
      const session = await devin.getSession(id);
      const { messages, complete } = await devin.listMessages(id);
      if (!complete) console.warn('Devin Bridge read a cut-short Devin message list', { devinSessionId: id });
      const said = (complete ? spoken(messages, memo) : []).map(({ id, body }) => ({ id, text: body }));
      // Until Devin says something or its status moves, the status still describes the turn before the reply.
      if (memo && !memo.heard && said.length === 0 && sameState(memo.baseline.status, session.state)) {
        return { memo, said, status: session.state.kind === 'working' ? { kind: 'working' } : { kind: 'pending' } };
      }
      return { memo: memo && { ...memo, heard: true }, said, status: statusOf(session) };
    },
  };
}
