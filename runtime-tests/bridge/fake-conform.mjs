// conform() against fake-backend.ts, for core.test.mjs and for mutant.mjs.
import { conform } from './conform.mjs';

/** `setup(t)` returns the harness of a bridge bundled with the fake backend. `BackendError` is that bundle's. */
export function conformFake({ label, facts, setup, BackendError }) {
  conform({
    label,
    setup(t) {
      const h = setup(t);
      Object.assign(h.vendor.facts, { keeps: facts.keeps, empty: facts.opensEmpty, linked: facts.linked });
      return h;
    },
    identity: { slug: 'fake-bridge', name: 'Fake', aSession: 'a Fake session', linkLabel: 'Open in Fake' },
    facts: { dedupes: true, approves: true, ...facts },
    vendor: {
      sessions: (h) => h.vendor.chats,
      told: (h, chat) => ({ opened: chat.opened, messages: chat.received }),
      url: (chat) => chat.url,
      work: (h, chat) => { chat.status = { kind: 'working' }; },
      say: (h, chat, text) => h.vendor.say(chat, text),
      finish: (h, chat) => { chat.status = { kind: 'finished' }; },
      ask(h, chat, question) {
        h.vendor.say(chat, question);
        chat.status = { kind: 'asked', on: 'user' };
      },
      awaitApproval(h, chat, question) {
        h.vendor.say(chat, question);
        chat.status = { kind: 'asked', on: 'approval' };
      },
      fail: (h, chat) => { chat.status = { kind: 'failed', body: 'The Fake session failed.', keep: false }; },
      halted: (h, chat) => chat.halted,
      takes: (h, chat) => !chat.gone,
      lose: (h, call) => h.vendor.failNext(call, new BackendError({ kind: 'transient' }), { landed: true }),
    },
  });
}
