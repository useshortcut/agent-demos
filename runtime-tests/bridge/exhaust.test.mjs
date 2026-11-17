// Three tests of the bridge in the current directory, each through its real
// webhook and alarm loop against fake-backend.ts, held to the rules in
// ledger.mjs. The first explores every script of one scope on each of the
// eight kinds of backend, one worker thread per kind. The second checks the
// search's merging on a small scope. The rest replay the scripts in PINNED.
// ../README.md says what a scope holds.
//   EXHAUST=deep node --test ../runtime-tests/bridge/exhaust.test.mjs
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { BACKENDS, describeBackend, explore, loadBridge, replay, runEach, told, world } from './exhaust.mjs';
import { RULES } from './ledger.mjs';

// EXHAUST_ROOT names a bridge directory to test in place of the current one.
const root = pathToFileURL(`${process.env.EXHAUST_ROOT ?? process.cwd()}/`);
assert.ok(existsSync(new URL('src/core/port.ts', root)), 'exhaust.test.mjs tests the bridge in the current directory. Run `npm test` inside a bridge.');

const SCOPES = {
  default: { turns: [2, 3, 4], from: ['created', 'reply 2', 'reply 3', 'stop 1', 'stop 2', 'close'], during: ['stop 1', 'stop 2'], ahead: true, events: 4, faults: 1, refuse: ['prepare', 'send'], finish: 1, gone: 1, total: 4 },
  deep: { turns: [2, 3, 4], from: ['created', 'reply 2', 'reply 3', 'reply 4', 'stop 1', 'stop 2', 'stop 3', 'close'], during: ['stop 1', 'stop 2', 'stop 3'], events: 5, faults: 2, finish: 1, gone: 1, total: 6 },
};
const scope = { ...SCOPES[process.env.EXHAUST ?? 'default'], ...JSON.parse(process.env.EXHAUST_SCOPE ?? '{}') };

// With one fault to a script, a backend that deduplicates sends differs from
// its twin that repeats them only when that fault is a send that landed. Its
// other scripts are the twin's, so they are run once.
const scopeFor = ({ dedupes }) => (dedupes && scope.faults === 1 ? { ...scope, only: ['send lost', 'send dies'], ahead: false } : scope);

const explored = (facts) => new Promise((resolve, reject) => {
  const worker = new Worker(new URL('./exhaust-worker.mjs', import.meta.url), { workerData: { root: root.href, facts, scope: scopeFor(facts) } });
  worker.once('message', resolve).once('error', reject);
});

const pasted = (facts, steps) => `[${JSON.stringify(facts)}, ${JSON.stringify(steps)}]`.replaceAll('"', "'");

it(`keeps the ledger's rules over every script that holds at most ${scope.total} events, backend faults, agents that finish, and conversations that end, on each kind of backend`, async (t) => {
  const started = performance.now();
  const results = await Promise.all(BACKENDS.map(explored));
  const total = (field) => results.reduce((sum, result) => sum + BigInt(result[field]), 0n);
  t.diagnostic(`${total('scripts')} scripts through ${total('states')} states, ${total('steps')} steps run, on ${results.length} backends in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  const shortest = new Map();
  for (const { facts, broken } of results) {
    for (const found of broken) if (!shortest.has(found.rule) || found.steps.length < shortest.get(found.rule).steps.length) shortest.set(found.rule, { ...found, facts });
  }
  const report = [...shortest.values()].map(({ rule, problem, steps, facts }) => `${problem}\n  The rule: ${RULES[rule]}\n  On ${describeBackend(facts)}. To replay it, add to PINNED:\n  ['...', ${pasted(facts, steps).slice(1)},`);
  assert.ok(report.length === 0, `The shortest script that breaks each rule:\n\n${report.join('\n\n')}\n`);
});

// Scripts that once broke a rule, each titled with what the bridge does now.
// Each is replayed from the start and has to break no rule.
const DEVIN = { keeps: false, empty: false, dedupes: false };
const PINNED = [
  ['sends an older reply with the next one when it arrives after its turn ended in an error that Shortcut never took', { keeps: false, empty: true, dedupes: false }, ['reply 3', 'tick: send lost', 'gone', 'tick: halt dies', 'reply 2', 'reply 4', 'tick', 'rest']],
  ['opens the conversation that replaces one that is gone with an opening request that arrives before that open goes out', DEVIN, ['reply 3', 'tick: open dies', 'reply 2', 'gone', 'tick: halt dies', 'created', 'tick', 'rest']],
  ['sends a request with the next reply when its turn ended in an error that Shortcut never took', DEVIN, ['created', 'reply 2', 'tick: send fails', 'gone', 'tick: halt dies', 'reply 3', 'tick', 'rest']],
  ['ends the turn, and introduces nothing, when a stale stop cancels all that waited for an empty conversation that replaced one that is gone', { keeps: false, empty: true, dedupes: false }, ['reply 2', 'tick', 'created', 'gone', 'tick: prepare 2 fails', 'stop 1', 'tick', 'rest']],
  ['sends no context alone once the bridge is past the turn it started from, when a stale stop cancels the older reply that waited for a conversation that replaced one that is gone', DEVIN, ['reply 2', 'tick', 'gone', 'reply 4', 'tick: open dies', 'reply 3', 'tick: prepare fails', 'created', 'stop 3', 'tick', 'rest']],
  ['ends the turn, and opens no conversation, when a stale stop cancels all that waited to open the one after a conversation that is gone', DEVIN, ['reply 2', 'tick', 'created', 'gone', 'tick: halt dies', 'stop 1', 'tick', 'rest']],
  ['opens the next conversation with every reply after a stale stop\'s turn, also one inside the text of the open the stop gave up', DEVIN, ['reply 2', 'reply 3', 'tick: open fails', 'stop 1', 'tick', 'rest']],
  ['tells the first conversation the context when a stale stop cancels a late opening request beside an open whose answer was lost', DEVIN, ['reply 2', 'tick: open lost', 'created', 'stop 1', 'tick', 'tick', 'reply 3', 'tick', 'rest']],
  ['tells a conversation the context once when two stale stops pass a send that carries it alone', DEVIN, ['reply 3', 'tick', 'created', 'stop 1', 'tick: send fails', 'stop 2', 'reply 4', 'tick', 'rest']],
  ['tells a conversation opened after a stop the context when it arrives later', DEVIN, ['reply 2', 'stop 1', 'tick', 'created', 'reply 3', 'tick', 'rest']],
  ['repeats an open\'s text when the context arrives before its retry in a conversation opened after a stop', DEVIN, ['reply 2', 'stop 1', 'tick: open fails', 'created', 'tick', 'rest']],
  ['ends the turn, and opens no conversation, when the context of a late session.created is all that waits for a conversation that is gone', DEVIN, ['reply 2', 'tick', 'created', 'stop 1', 'gone', 'tick', 'rest']],
  ['drops a stopped opening request that a failed turn kept, when the next reply takes along what the turn dropped', DEVIN, ['reply 2', 'tick', 'created', 'gone', 'tick: halt dies', 'stop 1', 'reply 3', 'tick', 'rest']],
  ['drops the older reply that waits on a stop when a second stale stop cancels it', DEVIN, ['reply 3', 'tick: open dies', 'reply 2', 'tick: prepare fails', 'stop 1', 'stop 2', 'tick', 'rest']],
  ['ends the turn when the backend refuses the read of an empty conversation that a stop left with nothing to be asked', { keeps: false, empty: true, dedupes: false }, ['reply 2', 'tick', 'created', 'gone', 'tick: prepare 2 dies', 'stop 1', 'tick: prepare refused', 'rest']],
  ['ends the turn when the backend refuses the read of a conversation whose introduction landed unknown to the bridge, after a stop cancelled what it held', { keeps: false, empty: true, dedupes: false }, ['reply 2', 'tick', 'created', 'gone', 'tick: send dies', 'stop 1', 'tick: prepare refused', 'rest']],
  ['drops a late opening request that arrives after a turn failed on a send that had landed', { keeps: false, empty: true, dedupes: false }, ['reply 2', 'tick: send lost', 'gone', 'tick: halt dies', 'created', 'reply 3', 'tick', 'rest']],
  ['goes on reading the agent, and ends no turn, when the backend refuses the send that carries only the context', DEVIN, ['reply 2', 'stop 1', 'tick', 'created', 'tick: send refused', 'finish', 'tick', 'rest']],
  ['goes on reading the agent, and ends no turn, when the backend refuses the prepare of a send that would carry only the context', DEVIN, ['reply 2', 'stop 1', 'tick', 'created', 'tick: prepare refused', 'rest']],
  ['sends nothing a stop cancelled when the stop arrives while the step that would send it waits on the backend', DEVIN, ['created', 'tick', 'reply 2', 'tick: stop 2 during prepare', 'rest']],
  ['introduces nothing to a conversation it opened empty when the stop of the request arrives while that open is out', { keeps: false, empty: true, dedupes: false }, ['created', 'tick: stop 1 during open', 'rest']],
  ['opens the conversation with the opening request, and sends the newer reply there, when Shortcut refused the first acknowledgement because the user had already replied', DEVIN, ['created', 'ahead 2', 'tick', 'reply 2', 'tick', 'rest']],
  ['opens the next conversation with the reply that waited on a stop when Shortcut refused its acknowledgement because the user had already replied again', DEVIN, ['created', 'tick', 'stop 1', 'reply 2', 'ahead 3', 'tick', 'rest']],
  ['posts the answer of an agent that finished before a late context could go to it alone, and sends it no context', DEVIN, ['reply 2', 'tick', 'finish', 'stop 1', 'created', 'tick', 'rest']],
  ['reads the agent again before it retries a send that carries only the context, and posts an answer given since the first try', DEVIN, ['reply 2', 'tick', 'stop 1', 'created', 'tick: send fails', 'finish', 'tick', 'rest']],
  ['repeats a send that carries only the context under its key when the step dies after the read that came before it', DEVIN, ['reply 2', 'tick: stop 1 during open', 'created', 'tick: observe dies', 'tick', 'rest']],
];

const bridge = await loadBridge(root);

it('counts the scripts of a small scope as running each from its own start does', async (t) => {
  const small = { from: ['created', 'reply 2', 'stop 1'], events: 3, faults: 1, finish: 0, gone: 1, total: 4 };
  for (const facts of [DEVIN, { keeps: true, empty: true, dedupes: true }]) {
    const w = await world(t, bridge, facts);
    const start = await w.snapshot();
    const each = await runEach(w, small);
    await w.restore(start);
    const { scripts, broken } = await explore(w, small);
    assert.deepEqual(broken, []);
    assert.equal(scripts, each, `on ${describeBackend(facts)}`);
  }
});

// Scripts that still break a rule, each titled with what the bridge should do.
// Both need a backend fault in a script that also puts Shortcut ahead, which
// the default scope does not hold. Each runs as a todo, so it shows in the
// report and fails nothing. Move one to PINNED when the bridge keeps its rule.
const EMPTY = { keeps: false, empty: true, dedupes: false };
const OPEN = [
  ['keeps the reply that waits on a stop when Shortcut refuses its acknowledgement before the stop\'s halt has run', DEVIN, ['created', 'tick', 'reply 2', 'ahead 3', 'tick: prepare fails', 'stop 1', 'tick', 'rest']],
  ['sends the opening request of a session.created that arrives after a turn failed with an error Shortcut refused, when nothing has reached the agent', EMPTY, ['reply 2', 'ahead 3', 'tick: prepare refused', 'created', 'tick', 'rest']],
];

const replayed = ([title, facts, steps], options = {}) => it(title, options, async (t) => {
  const w = await world(t, bridge, facts);
  const broke = await replay(w, steps);
  assert.ok(broke.length === 0, `${broke.join('\n')}\nThe agent was told:\n${JSON.stringify(told(w), null, 2)}`);
});

for (const script of PINNED) replayed(script);
for (const script of OPEN) replayed(script, { todo: 'the bridge breaks a rule here' });
