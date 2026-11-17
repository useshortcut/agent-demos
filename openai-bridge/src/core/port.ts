import type { FirstPortState } from './bridge';
import { retryAfterMs } from './http';

export type Identity = {
  /** Prefix of every activity key: `{slug}:{turn}:{suffix}`. */
  slug: string;
  /** Names the bridge in log lines, and in the error it posts when it cannot reach the backend. */
  title: string;
  /** How activities name the agent. */
  name: string;
  /** `a {name} session`. The article depends on the name. */
  aSession: string;
  linkLabel: string;
};

/** A backend session the bridge knows. `url` is null when the backend has no page for one session. `memo` is the adapter's own durable state: the core saves it with the phase and hands it back, and never reads it. */
export type Conversation<M> = { id: string; url: string | null; memo: M };

/** What a stop or a retirement acts on: a conversation, or whatever an interrupted open made under a key. */
export type Target<M> =
  | { kind: 'live'; conversation: Conversation<M> }
  | { kind: 'unresolved'; key: string; lookups: number };

export type OpenRequest = {
  /** The same for every attempt of one generation of one Shortcut session, so an adapter finds its own earlier attempt by it. */
  key: string;
  title: string;
  /** The introduction and the opening request, ready to send. */
  text: string;
};

export type Opened<M> = {
  conversation: Conversation<M>;
  /** False when the conversation was created empty. The core then relays what `text` held, and the `prepare` of that relay answers `empty`. */
  delivered: boolean;
  /** Other conversations found under the key. The core retires them. */
  duplicates: Conversation<M>[];
};

/**
 * `empty`: the conversation holds no message yet, so the send that follows
 * introduces it. The backend is the only record of this. The core keeps none
 * of its own, because a send whose answer was lost would leave it wrong.
 * `gone`: the conversation cannot take a message any more. The core opens a
 * new one with the reply, unless the one that is gone was still empty. With
 * no reply to carry over, the core calls `observe` next, and the status that
 * call reports ends the turn.
 */
export type Prepared<M> = { empty: boolean } & ({ kind: 'ready'; memo: M } | { kind: 'gone' });

/** `key` is fixed with `text` when the send is prepared: a retried send repeats both, and no other send of any session carries the key. A backend whose sends are idempotent passes it on. */
export type Outgoing = { text: string; key: string };

/** One thing the agent said this turn. `id` is stable across reads: it becomes part of an activity key. */
export type Said = { id: string; text: string };

export type Status =
  /** The last send is not picked up yet. The core waits, and gives up after the pickup timeout. */
  | { kind: 'pending' }
  | { kind: 'working' }
  /** `user`: the turn is handed back. `approval`: the answer is given in the backend's own app, so the core keeps polling. */
  | { kind: 'asked'; on: 'user' | 'approval' }
  /** `footer` goes above the link in the response. */
  | { kind: 'finished'; footer?: string }
  /** `keep`: the conversation can still take the next reply. */
  | { kind: 'failed'; body: string; keep: boolean };

export type Observed<M> = {
  memo: M;
  /** What the agent said since the last send, oldest first. Empty when the list could not be read whole. A question is the last entry. */
  said: Said[];
  status: Status;
};

export type Halted =
  /** The conversation is over. The next reply opens a new one. */
  | { kind: 'ended'; url: string | null }
  /** The work stopped and the conversation still takes replies. */
  | { kind: 'kept' }
  /** An unresolved key found nothing. It may be read-after-write lag, so the core looks again. */
  | { kind: 'unseen' };

export type BackendFailure =
  /** Wait for `retryAfterMs` without spending a strike. */
  | { kind: 'hold'; retryAfterMs: number }
  | { kind: 'transient' }
  | { kind: 'rejected'; status: number };

/** The only error an adapter throws. Anything else is a bug and reaches the alarm's catch. */
export class BackendError extends Error {
  constructor(readonly failure: BackendFailure) {
    super('Backend request failed');
  }
}

export function failureOf(status: number, retryAfter: string | null, now: number): BackendFailure {
  if (status === 429) return { kind: 'hold', retryAfterMs: retryAfterMs(retryAfter, now) };
  if (status >= 400 && status < 500) return { kind: 'rejected', status };
  return { kind: 'transient' };
}

export interface Backend<M> {
  /**
   * Safe to repeat for one `key`: either the adapter finds what an earlier
   * attempt created under the key, or the open delivers no text and starts no
   * work, so one lost to a crash is inert. Halting an unresolved key of the
   * second kind answers `ended` without a call.
   */
  open(request: OpenRequest): Promise<Opened<M>>;
  /** Reads what the next send depends on, and whether the conversation holds a message yet. The core saves the memo before the send goes out. */
  prepare(conversation: Conversation<M>): Promise<Prepared<M>>;
  /** `conversation.memo` is the prepared memo. Returns the memo that places the agent's answer. */
  send(conversation: Conversation<M>, message: Outgoing): Promise<M>;
  /** Read-only at the backend. The same memo and the same backend state give the same answer. The core also calls it between a `prepare` and its `send`, with the memo from before that prepare, when the send carries no request. */
  observe(conversation: Conversation<M>): Promise<Observed<M>>;
  /** Stops the work. A session that is already stopped or gone is a success. */
  halt(target: Target<M>): Promise<Halted>;
}

/** What `src/backend.ts` exports. `core/app.ts` checks it with `satisfies`. */
export type BackendModule<M, E> = {
  identity: Identity;
  /** The names `/webhook` and `/oauth/callback` require, on top of the Shortcut ones. */
  secrets: readonly (keyof E & string)[];
  connect(env: E): Backend<M>;
  /** Reads a state this bridge stored before the backend port, into the shape the first port stored. A bridge that never stored one leaves it out. */
  upgradeState?: (stored: unknown) => FirstPortState | null;
};
