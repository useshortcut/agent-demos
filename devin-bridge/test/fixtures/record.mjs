// Rewrites pre-port-states.json: runs the scenarios in ../upgrade.test.mjs
// against the bridge as it was before the backend port, the code that stored
// the states a deployed bridge still holds. Run from devin-bridge:
//   node test/fixtures/record.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BEFORE_PORT = 'c82857e0d93d10fff7a62e87590f8bdc4bc5f37a';
const bridge = fileURLToPath(new URL('../..', import.meta.url));
const old = mkdtempSync(join(tmpdir(), 'devin-bridge-before-port-'));
try {
  const archive = execFileSync('git', ['archive', `${BEFORE_PORT}:devin-bridge`, 'src', 'test/harness.mjs'], { cwd: join(bridge, '..'), maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', old], { input: archive });
  symlinkSync(join(bridge, 'node_modules'), join(old, 'node_modules'), 'dir');
  execFileSync(process.execPath, ['--test', 'test/upgrade.test.mjs'], { cwd: bridge, env: { ...process.env, RECORD_FROM: old }, stdio: 'inherit' });
} finally {
  rmSync(old, { recursive: true, force: true });
}
