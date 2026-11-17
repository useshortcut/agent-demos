import { conform } from '../../runtime-tests/bridge/conform.mjs';
import { setup } from './harness.mjs';

conform({
  setup,
  identity: { slug: 'openai-bridge', name: 'OpenAI', aSession: 'an OpenAI session', linkLabel: 'Open in OpenAI' },
  // A session that waits for an approval is given up, because the bridge cannot give one.
  facts: { keeps: true, opensEmpty: false, linked: false, dedupes: true, approves: false },
  vendor: {
    sessions: (h) => h.openai.sessions,
    told: (h, session) => ({ opened: session.opened, messages: session.received }),
    url: () => null,
    work: (h, session) => h.openai.work(session),
    say: (h, session, text) => h.openai.say(session, text),
    finish: (h, session) => h.openai.finish(session),
    ask: (h, session, question) => h.openai.ask(session, question),
    fail: (h, session) => h.openai.failSession(session),
    halted: (h, session) => session.cancels > 0,
    takes: (h, session) => session.status !== 'failed',
    lose: (h, call) => { h.openai.state[call === 'open' ? 'loseCreate' : 'loseSend'] = true; },
  },
});
