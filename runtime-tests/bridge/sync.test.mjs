import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./sync.mjs', import.meta.url));
const SYNC = 'src/core is the same in every bridge. Run `npm run core:sync` in the bridge whose copy is right.';

const CORE = {
  'src/core/port.ts': "import type { State } from './app';\nexport type Port = { state: State };\n",
  'src/core/app.ts': "import { connect } from '../backend';\nimport type { Port } from './port';\nexport type State = { port?: Port };\nexport default connect;\n",
};
const bridge = (name, files = {}) => Object.fromEntries(Object.entries({
  ...CORE,
  'src/index.ts': "export { default } from './core/app';\n",
  'src/backend.ts': "import { type Port } from './core/port';\nimport type { State } from './core/app';\nexport const connect = (port: Port, state: State) => [port, state];\n",
  ...files,
}).map(([path, text]) => [`${name}/${path}`, text]));
const ci = (demos) => ({ '.github/workflows/ci.yml': `jobs:\n  test:\n    strategy:\n      matrix:\n        demo: [${demos.join(', ')}]\n` });

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-sync-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const twoBridges = (overrides = {}) => repo({
  ...bridge('a-bridge'),
  ...bridge('b-bridge'),
  'quote-agent/src/index.ts': "import { x } from '../../elsewhere';\n",
  ...ci(['a-bridge', 'b-bridge', 'quote-agent']),
  ...overrides,
});

function run(mode, root, cwd = root) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [SCRIPT, mode, '--root', root], { cwd, encoding: 'utf8' });
  return { status, stdout, stderr };
}

function fails(root, message) {
  const result = run('check', root);
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.includes(`- ${message}\n`), result.stderr);
}

it('passes bridges whose cores match and whose imports respect the seam, and ignores other demos', () => {
  const result = run('check', twoBridges());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Bridge core check passed: a-bridge, b-bridge.\n');
});

it('passes a single bridge, which has no copy to compare', () => {
  const result = run('check', repo({ ...bridge('a-bridge'), ...ci(['a-bridge']) }));
  assert.equal(result.status, 0, result.stderr);
});

it('fails when a core file differs between bridges', () => {
  fails(twoBridges({ 'b-bridge/src/core/app.ts': `${CORE['src/core/app.ts']}// edited in one copy\n` }),
    `b-bridge/src/core/app.ts differs from a-bridge/src/core/app.ts. ${SYNC}`);
});

it('fails when a core file exists in one bridge and not another', () => {
  fails(twoBridges({ 'b-bridge/src/core/extra.ts': 'export const extra = 1;\n' }),
    `b-bridge/src/core/extra.ts has no copy at a-bridge/src/core/extra.ts. ${SYNC}`);
});

it('fails when a core file imports past the seam, and allows the core and exactly ../backend', () => {
  const leaks = "import { devinClient } from '../devin';\nexport * from '../backend.ts';\nimport '../setup';\n";
  const root = twoBridges({ 'a-bridge/src/core/app.ts': leaks + CORE['src/core/app.ts'], 'b-bridge/src/core/app.ts': leaks + CORE['src/core/app.ts'] });
  for (const spec of ['../devin', '../backend.ts', '../setup']) {
    fails(root, `a-bridge/src/core/app.ts imports '${spec}', which is outside src/core. The core reaches its backend only through '../backend'. Move the code into src/core or into src/backend.ts.`);
  }
  assert.equal(run('check', root).stderr.split('\n').filter((line) => line.startsWith('- ')).length, 6, 'three leaks in each of two bridges, and nothing else');
});

it('fails when code outside the core imports a value from a core file other than port or app', () => {
  const root = twoBridges({ 'b-bridge/src/upgrade.ts': "import { applyEvent } from './core/bridge';\nimport type { Phase } from './core/bridge';\n" });
  fails(root, "b-bridge/src/upgrade.ts imports a value from './core/bridge'. Outside src/core, import values only from core/port or core/app, and anything else with `import type`.");
  assert.equal(run('check', root).stderr.match(/core\/bridge/g).length, 1, 'the type-only import is allowed');
});

it('allows type-only imports of any core file from outside the core', () => {
  const upgrade = { 'src/upgrade.ts': "import type { Phase, State } from './core/app';\nimport type {\n  Port,\n} from './core/port';\nimport type { Hidden } from './core/inner';\n" };
  const result = run('check', twoBridges({ ...bridge('a-bridge', upgrade), ...bridge('b-bridge', upgrade) }));
  assert.equal(result.status, 0, result.stderr);
});

it('fails when a bridge is missing from the CI matrix', () => {
  fails(twoBridges(ci(['a-bridge', 'quote-agent'])), '.github/workflows/ci.yml has no b-bridge in its demo matrix. Add it so CI tests that bridge.');
});

it('sync copies the current bridge over the others, removes files it lacks, and then passes', () => {
  const root = twoBridges({
    ...bridge('c-bridge', { 'src/core/stale.ts': 'export {};\n', 'src/core/app.ts': '// drifted\n' }),
    'a-bridge/src/core/nested/new.ts': "import type { Port } from '../port';\nexport type New = Port;\n",
    ...ci(['a-bridge', 'b-bridge', 'c-bridge']),
  });
  fails(root, `c-bridge/src/core/app.ts differs from a-bridge/src/core/app.ts. ${SYNC}`);

  const result = run('sync', root, join(root, 'a-bridge'));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [
    'Copied a-bridge/src/core to b-bridge/src/core.',
    'Copied a-bridge/src/core to c-bridge/src/core.',
    'Bridge core check passed: a-bridge, b-bridge, c-bridge.',
    '',
  ].join('\n'));
  assert.equal(readFileSync(join(root, 'c-bridge/src/core/app.ts'), 'utf8'), CORE['src/core/app.ts']);
  assert.ok(existsSync(join(root, 'b-bridge/src/core/nested/new.ts')));
  assert.ok(!existsSync(join(root, 'c-bridge/src/core/stale.ts')));
});

it('sync refuses to run outside a bridge', () => {
  const root = twoBridges();
  const result = run('sync', root, join(root, 'quote-agent'));
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'Run `npm run core:sync` inside the bridge whose src/core is right.\n');
  assert.equal(readFileSync(join(root, 'b-bridge/src/core/app.ts'), 'utf8'), CORE['src/core/app.ts']);
});
