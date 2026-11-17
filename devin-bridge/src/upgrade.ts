import type { Memo } from './backend';
import type { Activity, FirstPortState, Pending } from './core/bridge';
import type { DevinState } from './devin';
import type { Conversation, Target } from './core/port';

type Phase = FirstPortState['phase'];
type Send = NonNullable<Extract<Phase, { kind: 'relay' }>['send']>;

type Fields = Record<string, unknown>;

class Unrecognized extends Error {}

function check(ok: boolean): void {
  if (!ok) throw new Unrecognized();
}

function fields(value: unknown): Fields {
  check(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Fields;
}

function text(value: unknown): string {
  check(typeof value === 'string');
  return value as string;
}

function count(value: unknown): number {
  check(typeof value === 'number' && Number.isFinite(value));
  return value as number;
}

function flag(value: unknown): boolean {
  check(typeof value === 'boolean');
  return value as boolean;
}

function list<T>(value: unknown, item: (value: unknown) => T): T[] {
  check(Array.isArray(value));
  return (value as unknown[]).map(item);
}

const nullable = <T>(value: unknown, read: (value: unknown) => T): T | null => (value === null ? null : read(value));

function pending(value: unknown): Pending {
  const { turn, text: body, opening } = fields(value);
  check(opening === undefined || opening === true);
  const reply = { turn: count(turn), text: text(body) };
  return opening ? { ...reply, opening: true } : reply;
}

function activity(value: unknown): Activity {
  const { key, turn, content, ephemeral } = fields(value);
  const { type, body } = fields(content);
  check((type === 'thought' || type === 'elicitation' || type === 'response' || type === 'error') && (ephemeral === undefined || ephemeral === true));
  return { key: text(key), turn: count(turn), content: { type: type as Activity['content']['type'], body: text(body) }, ...(ephemeral ? { ephemeral: true as const } : {}) };
}

// Kept as stored: the adapter compares it with Devin's status as JSON.
function devinState(value: unknown): DevinState {
  const state = fields(value);
  check(['working', 'waiting', 'finished', 'failed'].includes(state.kind as string));
  return state as DevinState;
}

function baseline(value: unknown) {
  const { last, status } = fields(value);
  return { last: nullable(last, text), status: devinState(status) };
}

function conversation(value: unknown, memo: Memo = null): Conversation<Memo> {
  const { id, url } = fields(value);
  return { id: text(id), url: text(url), memo };
}

function target(value: unknown): Target<Memo> {
  const held = fields(value);
  if (held.kind === 'live') return { kind: 'live', conversation: conversation(held) };
  check(held.kind === 'unresolved');
  return { kind: 'unresolved', key: text(held.tag), lookups: count(held.lookups) };
}

// The text the relay sent before the port: a late context first, then the replies in turn order.
function send(value: unknown): Send {
  const stored = fields(value);
  const prompt = list(stored.prompt, pending);
  const late = nullable(stored.late, pending);
  const ordered = [...prompt].sort((a, b) => a.turn - b.turn);
  return { prompt, late, text: (late ? [late, ...ordered] : ordered).map((p) => p.text).join('\n\n'), memo: { baseline: baseline(stored.baseline), prompt: null, heard: false } };
}

function phase(value: unknown): Phase {
  const stored = fields(value);
  switch (stored.kind) {
    case 'start':
      return { kind: 'start', prompt: list(stored.prompt, pending), extra: list(stored.extra, pending), attempted: flag(stored.attempted) };
    case 'relay':
      return { kind: 'relay', on: conversation(stored.link), prompt: list(stored.prompt, pending), send: nullable(stored.send, send) };
    case 'poll': {
      const relayed = nullable(stored.relayed, fields);
      const memo: Memo = relayed && { baseline: baseline(relayed.baseline), prompt: text(relayed.prompt), heard: flag(relayed.heard) };
      const at = count(stored.at);
      const delayMs = count(stored.delayMs);
      return {
        kind: 'poll',
        on: conversation(stored.link, memo),
        at,
        delayMs,
        check: flag(stored.check),
        posted: nullable(stored.posted, text),
        asked: nullable(stored.asked, text),
        // With nothing relayed there is no pickup to time, so the last poll's schedule stands in.
        sentAt: relayed ? count(relayed.since) : at - delayMs,
        // A poll stored before heartbeats existed has none. The code before the port compared the clock with the missing value, so the next quiet poll reported at once.
        heartbeatAt: stored.heartbeatAt === undefined ? 0 : count(stored.heartbeatAt),
      };
    }
    case 'stop':
      return { kind: 'stop', target: nullable(stored.target, target), waiting: list(stored.then, pending) };
    case 'idle':
      return { kind: 'idle', on: nullable(stored.link, (link) => conversation(link)) };
    case 'closed':
      return { kind: 'closed' };
  }
  throw new Unrecognized();
}

function jobs<T>(value: unknown, read: (value: unknown) => T) {
  const { devin, shortcut, retire, link } = fields(value);
  return { backend: read(devin), shortcut: read(shortcut), retire: read(retire), link: read(link) };
}

/** Reads a state stored before the backend port, which has no `v`, field by field into the shape the first port stored. Null when a field is not what that code stored. */
export function upgradeState(stored: unknown): FirstPortState | null {
  try {
    const state = fields(stored);
    check(state.v === undefined);
    const entity = fields(state.entity);
    return {
      v: 2,
      shortcutSessionId: text(state.shortcutSessionId),
      workspaceId: text(state.workspaceId),
      entity: { type: text(entity.type), id: count(entity.id) },
      context: text(state.context),
      turn: count(state.turn),
      first: count(state.first),
      late: nullable(state.late, pending),
      generation: count(state.generation),
      cutoff: count(state.cutoff),
      sent: count(state.sent),
      phase: phase(state.phase),
      retire: list(state.retire, target),
      linked: nullable(state.linked, text),
      outbox: list(state.outbox, activity),
      failures: jobs(state.failures, count),
      notBefore: jobs(state.notBefore, (deadline) => nullable(deadline, count)),
      applied: count(state.applied),
    };
  } catch (error) {
    if (error instanceof Unrecognized) return null;
    throw error;
  }
}
