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

it('creates the Devin session with the opening request when the user replies before the bridge has acknowledged turn 1', async (t) => {
  const h = setup(t);
  await h.connect();
  const created = h.shortcut.open(SID, { body: 'Only diagnose (private-prompt)' });
  const reply = h.shortcut.prompt(SID, 'Also examine Firefox (private-prompt)');
  await accept(h, created);
  await h.tick();
  await accept(h, reply);
  await h.tick();
  const devin = h.devin.only();
  assert.match(devin.prompt, /Only diagnose \(private-prompt\)/);
  assert.deepEqual(devin.received, ['Also examine Firefox (private-prompt)']);
  assert.deepEqual(h.shortcut.activities().filter((a) => a.content.type === 'error'), []);
  h.assertCleanLogs();
});

it('posts Devin\'s answer when the context of a late session.created arrives after Devin finished and before the bridge read it', async (t) => {
  const h = setup(t);
  await h.connect();
  const created = h.shortcut.open();
  const stop = h.shortcut.stop(SID);
  await accept(h, h.shortcut.prompt(SID, 'Start here (private-prompt)'));
  await h.tick();
  const devin = h.devin.only();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  h.devin.say(devin, 'All done');
  await accept(h, stop);
  await accept(h, created);
  await h.tick();
  assert.deepEqual(devin.received, [], 'the context is not sent past an answer the bridge has not read');
  assert.deepEqual(h.shortcut.activities().filter((a) => a.content.type !== 'thought').map((a) => [a.key, a.content.body.split('\n')[0]]), [['devin-bridge:2:response', 'All done']]);
  assert.equal(await h.alarmIn(), null);
  h.assertCleanLogs();
});
