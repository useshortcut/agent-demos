// conform() is what a new backend adapter is written against, so it has to
// fail an adapter that breaks the contract. Each mutant in mutant.mjs is the
// fake backend with one wrong behavior. This runs conform() against each in a
// child process, as the kind of backend on which the behavior shows, and
// expects the scenario that owns the behavior to fail.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SUITE = fileURLToPath(new URL('./mutant.mjs', import.meta.url));

/** `facts` replace those of mutant.mjs: a backend that ends its conversation on a stop, opens it with the request, and takes the send key. */
function conformWith(mutant, facts = {}) {
  // Without NODE_TEST_CONTEXT the child prints its own report instead of streaming events to this run.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  return new Promise((resolve) => {
    execFile(process.execPath, ['--test', '--test-reporter=tap', SUITE], { env: { ...env, MUTANT: mutant, FACTS: JSON.stringify(facts) } }, (error, stdout) => {
      const titles = (verdict) => [...stdout.matchAll(new RegExp(`^\\s*${verdict} \\d+ - (.*)$`, 'gm'))].map(([, title]) => title.replace(/^[^:]*: /, ''));
      resolve({ passed: titles('ok'), failed: titles('not ok'), stdout });
    });
  });
}

const EMPTY = { opensEmpty: true };

for (const [kind, facts] of [['', {}], [' when it opens its conversation empty', EMPTY]]) {
  it(`passes the fake backend as it is${kind}`, async () => {
    const { passed, failed, stdout } = await conformWith('', facts);
    assert.deepEqual(failed, [], stdout);
    assert.ok(passed.length >= 12, `every scenario ran: ${stdout}`);
  });
}

it('passes a backend that says it cannot take the send key and still delivers a repeated send once', async () => {
  const { passed, failed, stdout } = await conformWith('', { dedupes: false });
  assert.deepEqual(failed, [], stdout);
  assert.ok(passed.some((title) => /^delivers a reply no more than twice /.test(title)), `the scenario ran: ${stdout}`);
});

const OPENS = /^opens one session and tells it the request, the story link, and the context once$/;
const REPLIES = /^sends a reply to the same session and answers it on its own turn$/;
const STOPS = /^stops the work, answers "Stopped\.", and sends the next reply to a new session$/;

for (const [mutant, scenario, facts = {}] of [
  ['open ignores its key', /^tells one session the opening text, once, when an open reaches the backend and its answer is lost$/],
  ['send ignores its key', /^delivers a reply once when its send reaches the backend and the answer is lost$/],
  ['open answers delivered for a conversation it opened empty', OPENS, EMPTY],
  ['prepare never reports a conversation empty', OPENS, EMPTY],
  ['prepare reports every conversation empty', REPLIES],
  ['observe ignores the prepared memo', REPLIES],
  ['observe returns only the first message', /^posts the agent's (newest message as progress while it works|last message as the response when it finishes)$/],
  ['observe reports a question for the user as an approval', /^asks the agent's question, hands the turn back, and passes the answer to the same session$/],
  ['observe reports an approval as a question for the user', /^asks for the approval the agent waits on, keeps reading it, and posts its answer when it finishes$/],
  ['halt answers ended and ends nothing', STOPS],
  ['halt answers kept and ends the conversation', STOPS],
]) {
  it(`fails a backend whose ${mutant}`, async () => {
    const { failed, stdout } = await conformWith(mutant, facts);
    assert.ok(failed.some((title) => scenario.test(title)), `the scenario that owns the behavior fails. Failed: ${JSON.stringify(failed)}\n${stdout}`);
  });
}
