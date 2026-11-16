// The exhaustive run is worth trusting only if it fails a core that is wrong.
// Each case copies the src of the bridge in the current directory and
// replaces lines of core/bridge.ts in the copy. It then explores one scope on
// one kind of backend, over the bridge as it is and over the copy. The bridge
// as it is has to break no rule, and the copy has to break the rule the case
// names. A line that is not in bridge.ts exactly once fails the case, so
// change the case with the line.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const bridge = process.cwd();
assert.ok(existsSync(join(bridge, 'src/core/port.ts')), 'broken-cores.test.mjs tests the bridge in the current directory. Run `npm test` inside a bridge.');

const DEVIN = { keeps: false, empty: false, dedupes: false };
const BROKEN = [
  {
    core: 'drops every send it prepared',
    replace: [['  return { ...settled, briefing: empty && briefs ? \'introduced\' : settled.briefing, phase: { ...phase, prompt: [], send: { prompt, briefs, text, key: sendKey(state), memo } } };', '  return { ...settled, phase: text ? polling(phase.on, now) : phase };']],
    facts: { ...DEVIN, empty: true },
    scope: { from: ['created', 'reply 2'], events: 2, faults: 0, finish: 0, gone: 0, total: 2 },
    breaks: 'rest',
  },
  {
    core: 'forgets the stop a cancelled request arrives after',
    replace: [
      ['  if (reply.turn <= Math.max(state.cutoff, state.sent)) return state;', '  if (reply.turn <= state.sent) return state;'],
      ['  const asked = turn > current.cutoff && (current.generation === 1 || current.turn === current.first) ? text(event) : \'\';', '  const asked = text(event);'],
    ],
    facts: DEVIN,
    scope: { from: ['created', 'reply 2', 'reply 3', 'stop 1', 'stop 2'], events: 3, faults: 0, finish: 0, gone: 0, total: 3 },
    breaks: 'stopped',
  },
  {
    core: 'takes the context as told once a send that carries it is prepared, so a send that is then dropped loses it',
    replace: [['briefing: empty && briefs ? \'introduced\' : settled.briefing, phase: { ...phase, prompt: [], send:', 'briefing: briefs ? \'given\' : settled.briefing, phase: { ...phase, prompt: [], send:']],
    facts: DEVIN,
    scope: { from: ['created', 'reply 2', 'reply 3', 'stop 1'], events: 4, faults: 1, only: ['send fails'], finish: 0, gone: 0, total: 5 },
    breaks: 'briefed',
  },
  {
    core: 'introduces a conversation a second time when the answer to its first introduction was lost',
    replace: [['  const settled: SessionState = !empty && state.briefing === \'introduced\' ? { ...state, briefing: \'given\' } : state;', '  empty ||= state.briefing === \'introduced\';\n  const settled = state;']],
    facts: { keeps: true, empty: true, dedupes: true },
    scope: { from: ['created', 'reply 2', 'stop 1'], events: 3, faults: 1, only: ['send lost'], finish: 0, gone: 0, total: 4 },
    breaks: 'briefedOnce',
  },
  {
    core: 'introduces an empty conversation that replaced one that ended, after a stop cancelled all it was opened for',
    replace: [['  const alone = opening(settled) && (empty ? settled.generation === 1 : briefs);', '  const alone = opening(settled) && (empty || briefs);']],
    facts: { ...DEVIN, empty: true },
    scope: { from: ['created', 'reply 2', 'stop 1'], events: 3, faults: 1, only: ['prepare fails'], finish: 0, gone: 1, total: 5 },
    breaks: 'owed',
  },
  {
    core: 'ends the turn when the backend refuses a send that carried only the context',
    replace: [['  if (!phase.working || phase.send?.prompt.length) return null;', '  if (phase.on) return null;']],
    facts: DEVIN,
    scope: { from: ['created', 'reply 2', 'stop 1'], events: 3, faults: 1, only: ['send refused'], finish: 0, gone: 0, total: 4 },
    breaks: 'alone',
  },
];

function brokenCopy(replace) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-broken-core-'));
  cpSync(join(bridge, 'src'), join(root, 'src'), { recursive: true });
  cpSync(join(bridge, 'package.json'), join(root, 'package.json'));
  symlinkSync(join(bridge, 'node_modules'), join(root, 'node_modules'), 'dir');
  const file = join(root, 'src/core/bridge.ts');
  let source = readFileSync(file, 'utf8');
  for (const [from, to] of replace) {
    assert.equal(source.split(from).length - 1, 1, `src/core/bridge.ts holds this line once, to break:\n${from}`);
    source = source.replace(from, () => to);
  }
  writeFileSync(file, source);
  return root;
}

const explored = (directory, facts, scope) => new Promise((resolve, reject) => {
  const worker = new Worker(new URL('./exhaust-worker.mjs', import.meta.url), { workerData: { root: pathToFileURL(`${directory}/`).href, facts, scope: { turns: [2, 3, 4], ...scope } } });
  worker.once('message', resolve).once('error', reject);
});

for (const { core, replace, facts, scope, breaks } of BROKEN) {
  it(`fails a core that ${core}`, async () => {
    const root = brokenCopy(replace);
    try {
      const [whole, { broken }] = await Promise.all([explored(bridge, facts, scope), explored(root, facts, scope)]);
      assert.deepEqual(whole.broken, [], 'the core as it is keeps every rule over this scope');
      assert.ok(broken.some(({ rule }) => rule === breaks), `the search breaks the rule "${breaks}". It broke: ${JSON.stringify(broken)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
