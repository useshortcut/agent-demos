// Every script of a small scope, through the real webhook and alarm loop of
// the bridge in the current directory, on every kind of backend the port
// allows, held to the rules in ledger.mjs. ../README.md says what the scope
// holds and how to replay a script.
//   EXHAUST=deep node --test ../runtime-tests/bridge/exhaust.test.mjs
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { BACKENDS, describeBackend, loadBridge, replay, told, world } from './exhaust.mjs';
import { RULES } from './ledger.mjs';

// EXHAUST_ROOT runs this against a bridge elsewhere, as broken-cores.test.mjs does with a copy it has broken.
const root = pathToFileURL(`${process.env.EXHAUST_ROOT ?? process.cwd()}/`);
assert.ok(existsSync(new URL('src/core/port.ts', root)), 'exhaust.test.mjs tests the bridge in the current directory. Run `npm test` inside a bridge.');

const SCOPES = {
  default: { turns: [2, 3, 4], from: ['created', 'reply 2', 'reply 3', 'stop 1', 'stop 2', 'close'], events: 4, faults: 1, finish: 1, gone: 1, total: 4 },
  deep: { turns: [2, 3, 4], from: ['created', 'reply 2', 'reply 3', 'reply 4', 'stop 1', 'stop 2', 'stop 3', 'close'], events: 5, faults: 2, finish: 1, gone: 1, total: 6 },
};
const scope = { ...SCOPES[process.env.EXHAUST ?? 'default'], ...JSON.parse(process.env.EXHAUST_SCOPE ?? '{}') };

// With one fault to a script, a backend that deduplicates sends differs from
// its twin that repeats them only when that fault is a send that landed. Its
// other scripts are the twin's, so they are run once.
const scopeFor = ({ dedupes }) => (dedupes && scope.faults === 1 ? { ...scope, only: ['send lost', 'send dies'] } : scope);

const explored = (facts) => new Promise((resolve, reject) => {
  const worker = new Worker(new URL('./exhaust-worker.mjs', import.meta.url), { workerData: { root: root.href, facts, scope: scopeFor(facts) } });
  worker.once('message', resolve).once('error', reject);
});

const pasted = (facts, steps) => `[${JSON.stringify(facts)}, ${JSON.stringify(steps)}]`.replaceAll('"', "'");

it(`keeps the ledger's rules over every script of up to ${scope.total} events, backend faults, and agent endings, on every kind of backend`, { todo: 'the core breaks one of the rules, and the next commit fixes it' }, async (t) => {
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

// Scripts that once broke a rule, each named for what it holds now. The deep
// run found the ones that are longer than the default scope.
const DEVIN = { keeps: false, empty: false, dedupes: false };
const PINNED = [
  ['tells the first conversation the context when a stale stop cancels a late opening request beside an open whose answer was lost', DEVIN, ['reply 2', 'tick: open lost', 'created', 'stop 1', 'tick', 'tick', 'reply 3', 'tick', 'rest']],
  ['tells a conversation the context once when two stale stops pass a send that carries it alone', DEVIN, ['reply 3', 'tick', 'created', 'stop 1', 'tick: send fails', 'stop 2', 'reply 4', 'tick', 'rest']],
  ['tells a conversation opened after a stop the context when it arrives later', DEVIN, ['reply 2', 'stop 1', 'tick', 'created', 'reply 3', 'tick', 'rest']],
  ['repeats an open\'s text when the context arrives before its retry in a conversation opened after a stop', DEVIN, ['reply 2', 'stop 1', 'tick: open fails', 'created', 'tick', 'rest']],
  ['ends the turn, and opens no conversation, when the context of a late session.created is all that waits for a conversation that is gone', DEVIN, ['reply 2', 'tick', 'created', 'stop 1', 'gone', 'tick', 'rest']],
];

const bridge = PINNED.length ? await loadBridge(root) : null;
for (const [title, facts, steps] of PINNED) {
  it(title, async (t) => {
    const w = await world(t, bridge, facts);
    const broke = await replay(w, steps);
    assert.ok(broke.length === 0, `${broke.join('\n')}\nThe agent was told:\n${JSON.stringify(told(w), null, 2)}`);
  });
}
