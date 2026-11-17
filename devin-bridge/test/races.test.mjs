// Races between Shortcut's events and the bridge's own steps, through the
// Devin adapter. ../../runtime-tests/bridge/races.test.mjs holds the same
// races for the core alone.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { SID, setup } from './harness.mjs';

const accept = async (h, event) => assert.equal((await h.deliver(event)).status, 200);

it('sends Devin nothing a stop cancelled when the stop arrives while the step reads Devin for the relay', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  await accept(h, h.shortcut.prompt(SID, 'Cancel this reply (private-prompt)'));
  const { release, reached } = h.devin.hold();
  const stepping = h.tick();
  await reached;
  await accept(h, h.shortcut.stop(SID));
  release();
  await stepping;
  assert.deepEqual(devin.received, []);
  assert.equal(devin.terminated, true);
  assert.ok(h.shortcut.activities().some((a) => a.key === 'devin-bridge:2:stopped'));
  h.assertCleanLogs();
});
