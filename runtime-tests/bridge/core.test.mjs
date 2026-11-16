// The core paths no real backend's tests reach, against fake-backend.ts. Runs
// in the `npm test` of the bridge in the current directory, against its src/core.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { SID, assertAbout, bridgeHarness } from './harness.mjs';

const root = pathToFileURL(`${process.cwd()}/`);
assert.ok(existsSync(new URL('src/core/port.ts', root)), 'core.test.mjs tests the bridge in the current directory. Run `npm test` inside a bridge.');

const bridge = await bridgeHarness({
  root,
  secrets: {},
  sensitive: /private|token-\d|refresh-\d/,
  backend: new URL('./fake-backend.ts', import.meta.url),
  vendor: { env: {}, mock: (log) => bridge.mod.backend.script(log) },
});
const { BackendError } = bridge.mod;

function setup(t) {
  const h = bridge.setup(t);
  h.env.FAKE = h.vendor;
  return Object.assign(h, {
    fake: h.vendor,
    calls: (method) => h.requests.filter((r) => r.origin === 'fake' && r.method === method),
    accept: async (event) => assert.equal((await h.deliver(event)).status, 200),
    ticks: async (n) => { for (let i = 0; i < n; i++) await h.tick(); },
    bodies: (type) => h.shortcut.activities().filter((a) => a.content.type === type).map((a) => a.content.body),
  });
}

it('opens one conversation for a session, however often its event is delivered, and posts the agent\'s progress and answer', async (t) => {
  const h = setup(t);
  await h.connect();
  const created = h.shortcut.open();
  await h.accept(created);
  await h.accept(created);
  await h.tick();
  const chat = h.fake.only();
  assert.match(chat.opened, /A Shortcut user asked:\n\nPlease fix the Safari login bug/);
  assert.equal(chat.key, 'shortcut-session-sess-1-1');

  h.fake.say(chat, 'Looking into it');
  await h.tick();
  await h.accept(created);
  h.fake.say(chat, 'Fixed it');
  chat.status = { kind: 'finished' };
  await h.ticks(2);
  assert.equal(h.calls('open').length, 1, 'a redelivered event opens nothing');
  assert.deepEqual(chat.received, []);
  assert.deepEqual(h.shortcut.activities().map((a) => [a.key, a.content.type, a.content.body.split('\n')[0]]), [
    ['fake-bridge:1:ack', 'thought', 'Starting a Fake session.'],
    ['fake-bridge:1:message:said-1', 'thought', 'Looking into it'],
    ['fake-bridge:1:response', 'response', 'Fixed it'],
  ]);
  assert.equal(await h.alarmIn(), null);
  h.assertCleanLogs();
});

it('waits out a hold without spending a strike, however many arrive in a row', async (t) => {
  const h = setup(t);
  const chat = await h.started();
  chat.status = { kind: 'finished' };
  await h.tick();
  await h.accept(h.shortcut.prompt(SID, 'Also fix Firefox'));
  for (let i = 0; i < 10; i++) h.fake.failNext('send', new BackendError({ kind: 'hold', retryAfterMs: 7_000 }));
  await h.tick();
  assertAbout(await h.alarmIn(), 7_000, 'the hold');
  await h.ticks(9);
  assert.deepEqual(chat.received, [], 'the send is still held');
  assert.deepEqual(h.bodies('error'), [], 'ten holds, two more than the failure budget, end nothing');
  await h.tick();
  assert.deepEqual(chat.received, ['Also fix Firefox']);
  assert.equal(h.calls('prepare').length, 1, 'a held send is not prepared again');
  h.assertCleanLogs();
});
