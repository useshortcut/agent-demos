import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { rules } from './plugin.mjs';

const root = new URL('../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('.oxlintrc.json', root), 'utf8'));

// Lints the fixtures with the repo's own config, so a rule that is written
// but not switched on fails here. oxlint exits non-zero when it finds
// something, which is what the invalid fixtures are for.
function lintFixtures() {
  try {
    return execFileSync('lint/node_modules/.bin/oxlint', ['-c', '.oxlintrc.json', '--format', 'json', 'lint/fixtures'], { cwd: root, encoding: 'utf8' });
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout !== '') return error.stdout;
    throw error;
  }
}

const { diagnostics } = JSON.parse(lintFixtures());

for (const name of Object.keys(rules)) {
  const filesIn = (kind) => readdirSync(new URL(`lint/fixtures/${name}/${kind}/`, root)).map((file) => `lint/fixtures/${name}/${kind}/${file}`);
  const flagged = new Set(diagnostics.filter((d) => d.code === `agent-demos(${name})`).map((d) => d.filename));

  test(`${name} is an error in .oxlintrc.json`, () => {
    assert.equal(config.rules[`agent-demos/${name}`], 'error');
  });

  test(`${name} flags every invalid fixture`, () => {
    const invalid = filesIn('invalid');
    assert.ok(invalid.length > 0);
    assert.deepEqual(invalid.filter((file) => !flagged.has(file)), []);
  });

  test(`${name} passes every valid fixture`, () => {
    const valid = filesIn('valid');
    assert.ok(valid.length > 0);
    assert.deepEqual(valid.filter((file) => flagged.has(file)), []);
  });
}
