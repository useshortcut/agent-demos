import { conform } from '../../runtime-tests/bridge/conform.mjs';
import { consoleUrl, setup } from './harness.mjs';

const vendor = {
  sessions: (h) => h.claude.sessions,
  // A reply that answers `ask_user` goes back as the call's result and counts as a message.
  told: (h, session) => ({ opened: null, messages: session.received }),
  url: consoleUrl,
  work: (h, session) => h.claude.work(session),
  say: (h, session, text) => h.claude.say(session, text),
  finish: (h, session) => h.claude.finish(session),
  ask: (h, session, question) => h.claude.ask(session, question),
  fail: (h, session) => h.claude.terminate(session),
  halted: (h, session) => session.interrupts > 0,
  takes: (h, session) => session.status !== 'terminated',
  lose: (h, call) => { h.claude.state.lose = call; },
};
const identity = { slug: 'claude-bridge', name: 'Claude', aSession: 'a Claude session', linkLabel: 'Open in Claude Console' };
// A session that waits for an approval is given up, because the bridge cannot approve a tool call.
const facts = { keeps: true, opensEmpty: true, dedupes: false, approves: false };

conform({ label: 'Claude bridge with a Console workspace', setup, identity, facts: { ...facts, linked: true }, vendor });
conform({ label: 'Claude bridge without a Console workspace', setup: (t) => setup(t, { linked: false }), identity, facts: { ...facts, linked: false }, vendor });
