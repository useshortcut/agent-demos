import { conform } from '../../runtime-tests/bridge/conform.mjs';
import { setup } from './harness.mjs';

const state = (session, status_detail, status = 'running') => Object.assign(session, { status, status_detail });

conform({
  setup,
  identity: { slug: 'devin-bridge', name: 'Devin', aSession: 'a Devin session', linkLabel: 'Open in Devin' },
  facts: { keeps: false, opensEmpty: false, linked: true },
  vendor: {
    sessions: (h) => h.devin.sessions,
    told: (h, session) => ({ opened: session.prompt, messages: session.received }),
    url: (session) => session.url,
    work: (h, session) => state(session, 'working'),
    say: (h, session, text) => h.devin.say(session, text),
    finish: (h, session) => state(session, 'finished'),
    ask(h, session, question) {
      h.devin.say(session, question);
      state(session, 'waiting_for_user');
    },
    fail: (h, session) => state(session, null, 'error'),
    halted: (h, session) => session.terminated === true,
  },
});
