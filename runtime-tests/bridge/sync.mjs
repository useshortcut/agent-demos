// Keeps src/core identical in every bridge.
//   node sync.mjs check [--root <repo>]   exits 1 and names each problem
//   node sync.mjs sync  [--root <repo>]   copies the src/core of the bridge in
//                                         the current directory over the others,
//                                         then checks
// A bridge is a top-level directory with src/core/port.ts.
import { cpSync, existsSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SYNC = 'src/core is the same in every bridge. Run `npm run core:sync` in the bridge whose copy is right.';
const STATEMENT = /\b(import|export)\s+(type\s+)?[\w$*{}\s,]+?\s+from\s*['"]([^'"]+)['"]/g;
const BARE = /\bimport\s*\(?\s*['"]([^'"]+)['"]/g;

const bridgesIn = (root) =>
  readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'src/core/port.ts')))
    .map((entry) => entry.name)
    .sort();

/** Paths under `dir`, relative to it, with forward slashes. */
const filesUnder = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();

/** Every relative import of a source file: its specifier, and whether only types come in. */
function importsOf(text) {
  const found = [...text.matchAll(STATEMENT)].map(([, , type, spec]) => ({ spec, typeOnly: Boolean(type) }));
  found.push(...[...text.matchAll(BARE)].map(([, spec]) => ({ spec, typeOnly: false })));
  return found.filter(({ spec }) => spec.startsWith('.'));
}

function sameCore(root, bridges) {
  const problems = [];
  const names = [...new Set(bridges.flatMap((bridge) => filesUnder(join(root, bridge, 'src/core'))))].sort();
  for (const name of names) {
    const copies = bridges.map((bridge) => ({ bridge, path: join(root, bridge, 'src/core', name) }));
    const [reference] = copies.filter(({ path }) => existsSync(path));
    const text = readFileSync(reference.path);
    for (const { bridge, path } of copies) {
      if (!existsSync(path)) problems.push(`${reference.bridge}/src/core/${name} has no copy at ${bridge}/src/core/${name}. ${SYNC}`);
      else if (!readFileSync(path).equals(text)) problems.push(`${bridge}/src/core/${name} differs from ${reference.bridge}/src/core/${name}. ${SYNC}`);
    }
  }
  return problems;
}

function sealedSeam(root, bridge) {
  const problems = [];
  const src = join(root, bridge, 'src');
  for (const file of filesUnder(src).filter((name) => /\.[cm]?[jt]s$/.test(name))) {
    const inCore = file.startsWith('core/');
    for (const { spec, typeOnly } of importsOf(readFileSync(join(src, file), 'utf8'))) {
      const target = posix.join(posix.dirname(file), spec);
      if (inCore && !target.startsWith('core/') && target !== 'backend') {
        problems.push(`${bridge}/src/${file} imports '${spec}', which is outside src/core. The core reaches its backend only through '../backend'. Move the code into src/core or into src/backend.ts.`);
      }
      if (!inCore && target.startsWith('core/') && !typeOnly && target !== 'core/port' && target !== 'core/app') {
        problems.push(`${bridge}/src/${file} imports a value from '${spec}'. Outside src/core, import values only from core/port or core/app, and anything else with \`import type\`.`);
      }
    }
  }
  return problems;
}

function testedInCi(root, bridges) {
  const workflow = join(root, '.github/workflows/ci.yml');
  const matrix = existsSync(workflow) ? readFileSync(workflow, 'utf8').match(/^\s*demo:\s*\[([^\]]*)\]/m) : null;
  const demos = matrix ? matrix[1].split(',').map((demo) => demo.trim()) : [];
  return bridges.filter((bridge) => !demos.includes(bridge)).map((bridge) => `.github/workflows/ci.yml has no ${bridge} in its demo matrix. Add it so CI tests that bridge.`);
}

function check(root) {
  const bridges = bridgesIn(root);
  return [...sameCore(root, bridges), ...bridges.flatMap((bridge) => sealedSeam(root, bridge)), ...testedInCi(root, bridges)];
}

function sync(root, from) {
  for (const bridge of bridgesIn(root).filter((bridge) => bridge !== from)) {
    const core = join(root, bridge, 'src/core');
    rmSync(core, { recursive: true, force: true });
    cpSync(join(root, from, 'src/core'), core, { recursive: true });
    console.log(`Copied ${from}/src/core to ${bridge}/src/core.`);
  }
}

const { positionals: [mode], values } = parseArgs({ allowPositionals: true, options: { root: { type: 'string' } } });
const root = realpathSync(values.root ?? join(dirname(fileURLToPath(import.meta.url)), '../..'));
if (mode === 'sync') {
  const from = relative(root, realpathSync(process.cwd())).split(sep)[0];
  if (!bridgesIn(root).includes(from)) {
    console.error('Run `npm run core:sync` inside the bridge whose src/core is right.');
    process.exit(1);
  }
  sync(root, from);
} else if (mode !== 'check') {
  console.error('Usage: node sync.mjs check|sync [--root <repo>]');
  process.exit(1);
}
const problems = check(root);
if (problems.length) {
  console.error(`Bridge core check failed:\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
  process.exit(1);
}
console.log(`Bridge core check passed: ${bridgesIn(root).join(', ')}.`);
