// The fake backend with the one wrong behavior that MUTANT names, run through
// conform(). mutants.test.mjs runs this file once per mutant and expects the
// scenario that owns the behavior to fail. With no MUTANT every scenario passes.
import { pathToFileURL } from 'node:url';
import { conformFake } from './fake-conform.mjs';
import { bridgeHarness } from './harness.mjs';

const bridge = await bridgeHarness({
  root: pathToFileURL(`${process.cwd()}/`),
  secrets: {},
  sensitive: /private|token-\d|refresh-\d/,
  backend: new URL('./fake-backend.ts', import.meta.url),
  vendor: { env: {}, mock: (log) => bridge.mod.backend.script(log) },
});

const MUTANTS = {
  'open ignores its key'({ backend }) {
    const { open } = backend;
    let opens = 0;
    backend.open = (request) => open({ ...request, key: `${request.key}#${++opens}` });
  },
  'send ignores its key'({ backend }) {
    const { send } = backend;
    let sends = 0;
    backend.send = (conversation, message) => send(conversation, { ...message, key: `${message.key}#${++sends}` });
  },
  'observe ignores the prepared memo'({ backend }) {
    const { observe } = backend;
    backend.observe = (conversation) => observe({ ...conversation, memo: { heard: 0 } });
  },
  'observe returns only the first message'({ backend }) {
    const { observe } = backend;
    backend.observe = async (conversation) => {
      const seen = await observe(conversation);
      return { ...seen, said: seen.said.slice(0, 1) };
    };
  },
  'observe reports a question for the user as an approval'({ backend }) {
    const { observe } = backend;
    backend.observe = async (conversation) => {
      const seen = await observe(conversation);
      return seen.status.kind === 'asked' ? { ...seen, status: { kind: 'asked', on: 'approval' } } : seen;
    };
  },
  'halt answers ended and ends nothing'({ backend, chats }) {
    const { halt } = backend;
    backend.halt = async (target) => {
      const halted = await halt(target);
      for (const chat of chats) chat.gone = false;
      return halted;
    };
  },
};

const mutate = MUTANTS[process.env.MUTANT] ?? null;
if (process.env.MUTANT && !mutate) throw new Error(`no mutant named ${JSON.stringify(process.env.MUTANT)}`);

conformFake({
  label: process.env.MUTANT || 'no mutant',
  facts: { keeps: false, opensEmpty: false, linked: true },
  BackendError: bridge.mod.BackendError,
  setup(t) {
    const h = bridge.setup(t);
    h.env.FAKE = h.vendor;
    mutate?.(h.vendor);
    return h;
  },
});
