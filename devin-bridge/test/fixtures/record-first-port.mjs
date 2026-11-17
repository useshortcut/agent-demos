// Rewrites first-port-states.json: runs the scenarios in ../stored.test.mjs
// against the bridge as it was when its backend port first stored states.
// `FirstPortState` in src/core/bridge.ts describes that shape. A deployed
// bridge of that version still holds such states. Run from devin-bridge:
//   node test/fixtures/record-first-port.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIRST_PORT = '9abbcd111ca1baca6353f45df0a85e131f2f4667';
const bridge = fileURLToPath(new URL('../..', import.meta.url));
const old = mkdtempSync(join(tmpdir(), 'devin-bridge-first-port-'));
try {
  // That bridge's harness imports the shared one, so both keep their places under one root.
  const archive = execFileSync('git', ['archive', FIRST_PORT, 'devin-bridge/src', 'devin-bridge/test/harness.mjs', 'runtime-tests/bridge/harness.mjs'], { cwd: join(bridge, '..'), maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', old], { input: archive });
  symlinkSync(join(bridge, 'node_modules'), join(old, 'devin-bridge/node_modules'), 'dir');
  execFileSync(process.execPath, ['--test', 'test/stored.test.mjs'], { cwd: bridge, env: { ...process.env, RECORD_FROM: join(old, 'devin-bridge') }, stdio: 'inherit' });
} finally {
  rmSync(old, { recursive: true, force: true });
}
