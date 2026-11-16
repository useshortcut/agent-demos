// A scripted, in-memory backend that takes the place of a bridge's
// src/backend.ts in the core's own tests. The harness swaps it in when it
// bundles the bridge under test, and a test drives it through `script`.
// It sits outside every demo and is bundled into whichever bridge runs the
// test, so it imports only types: a value would come from the wrong copy of
// the core.
import type { Backend, Conversation, Identity, Said, Status } from '../../devin-bridge/src/core/port';

export const identity: Identity = { slug: 'fake-bridge', title: 'Fake Bridge', name: 'Fake', aSession: 'a Fake session', linkLabel: 'Open in Fake' };

/** The test puts its script on the environment, so each test's bridge talks to its own. */
export type BackendEnv = { FAKE: Script };

export const secrets = [] as const;

/** How many of the chat's agent messages came before the last send. Those after it are the current turn. */
export type Memo = { heard: number };

export type Call = 'open' | 'prepare' | 'send' | 'observe' | 'halt';

/** One conversation at the fake vendor. A test reads it, and sets `status` and `gone` to script what the bridge sees next. */
export type Chat = {
  id: string;
  url: string | null;
  key: string;
  /** The text the open carried, or null for a chat opened empty. */
  opened: string | null;
  /** The messages delivered after the open, oldest first. A send repeated under its key delivers nothing new. */
  received: string[];
  /** Every send that reached the chat, repeats included. */
  sends: { key: string; text: string }[];
  said: Said[];
  status: Status;
  /** `prepare` answers `gone`. A halt that does not keep the chat sets it. */
  gone: boolean;
  halted: boolean;
};

export type Script = ReturnType<typeof script>;

/** `log` takes one entry per call, in order with the harness's Shortcut requests. */
export function script(log: unknown[]) {
  const chats: Chat[] = [];
  const failures: { call: Call; error: Error; landed: boolean }[] = [];
  /** What the bridge did that no backend should see. A test expects it to stay empty. */
  const misuse: string[] = [];
  /** What this backend is like. A test changes one before the call it bears on. */
  const facts = {
    /** A chat has a page of its own to link. */
    linked: true,
    /** A halt stops the work and the chat still takes messages. */
    keeps: false,
    /** An open creates a chat with no message in it and cannot find it again, so each open makes another. */
    empty: false,
  };
  let ids = 0;

  function attempt<T>(call: Call, path: string, run: () => T): T {
    log.push({ origin: 'fake', method: call, path });
    const failure = failures[0]?.call === call ? failures.shift() : undefined;
    if (failure && !failure.landed) throw failure.error;
    const result = run();
    if (failure) throw failure.error;
    return result;
  }

  function known(id: string): Chat {
    const chat = chats.find((candidate) => candidate.id === id);
    if (!chat) throw new Error(`the fake backend has no chat ${id}`);
    return chat;
  }

  const conversation = ({ id, url }: Chat): Conversation<Memo> => ({ id, url, memo: { heard: 0 } });

  const backend: Backend<Memo> = {
    // Unless it opens empty, a retried open finds the chat an interrupted one made under the same key.
    async open({ key, text }) {
      return attempt('open', key, () => {
        const n = chats.length + 1;
        const made: Chat = { id: `chat-${n}`, url: facts.linked ? `https://fake.example/chats/${n}` : null, key, opened: facts.empty ? null : text, received: [], sends: [], said: [], status: facts.empty ? { kind: 'pending' } : { kind: 'working' }, gone: false, halted: false };
        const chat = (!facts.empty && chats.find((candidate) => candidate.key === key)) || made;
        if (chat === made) chats.push(chat);
        return { conversation: conversation(chat), delivered: chat.opened !== null, duplicates: [] };
      });
    },

    async prepare({ id }) {
      return attempt('prepare', id, () => {
        const chat = known(id);
        return chat.gone ? { kind: 'gone' } : { kind: 'ready', memo: { heard: chat.said.length } };
      });
    },

    // Idempotent per key, like a vendor that takes an idempotency header.
    async send({ id, memo }, { text, key }) {
      return attempt('send', id, () => {
        const chat = known(id);
        const earlier = chats.flatMap((other) => other.sends).find((sent) => sent.key === key);
        if (earlier && (earlier.text !== text || !chat.sends.includes(earlier))) misuse.push(`send key ${key} was used for two different sends`);
        chat.sends.push({ key, text });
        if (earlier) return memo;
        chat.received.push(text);
        chat.status = { kind: 'working' };
        return memo;
      });
    },

    async observe({ id, memo }) {
      return attempt('observe', id, () => {
        const chat = known(id);
        return { memo, said: chat.said.slice(memo.heard), status: chat.status };
      });
    },

    async halt(target) {
      return attempt('halt', target.kind === 'live' ? target.conversation.id : target.key, () => {
        // An empty chat that was never told anything runs nothing, so there is nothing to look for.
        if (target.kind === 'unresolved' && facts.empty) return { kind: 'ended', url: null };
        const found = target.kind === 'live' ? [known(target.conversation.id)] : chats.filter((chat) => chat.key === target.key);
        const kept = target.kind === 'live' && facts.keeps;
        for (const chat of found) Object.assign(chat, { halted: true, gone: !kept });
        if (kept) return { kind: 'kept' };
        return found.length ? { kind: 'ended', url: found[0].url } : { kind: 'unseen' };
      });
    },
  };

  return {
    backend,
    facts,
    chats,
    misuse,
    only(): Chat {
      if (chats.length !== 1) throw new Error(`expected exactly one chat at the fake backend, found ${chats.length}`);
      return chats[0];
    },
    say(chat: Chat, text: string): void {
      chat.said.push({ id: `said-${++ids}`, text });
    },
    /** The next `call` throws `error`. With `landed`, it first does its work, like a request whose answer was lost. */
    failNext(call: Call, error: Error, { landed = false } = {}): void {
      failures.push({ call, error, landed });
    },
  };
}

export const connect = (env: BackendEnv): Backend<Memo> => env.FAKE.backend;
