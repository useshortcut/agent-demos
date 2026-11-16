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

// The session's next save once `reached()` holds fails, and the object restarts, as when it is evicted mid-step.
function dieAtSaveAfter(h, reached) {
  const storage = h.env.SESSIONS.storages.get(SID);
  const put = storage.put;
  storage.put = async (...args) => {
    if (!reached()) return put.apply(storage, args);
    storage.put = put;
    h.env.SESSIONS.restart();
    throw new Error('evicted');
  };
  return () => storage.put === put;
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
  assert.deepEqual(h.shortcut.sessions.get(SID).external_urls, [{ label: 'Open in Fake', url: chat.url }]);
  assert.equal(h.bodies('response')[0], `Fixed it\n\n[Open in Fake](${chat.url})`);
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

it('writes no link text and sets no card link for a conversation without a URL, whatever the turn ends in', async (t) => {
  const h = setup(t);
  h.fake.facts.linked = false;
  const chat = await h.started();
  assert.equal(chat.url, null);
  h.fake.say(chat, 'Looking into it');
  await h.tick();
  h.fake.say(chat, 'Which browser?');
  chat.status = { kind: 'asked', on: 'user' };
  await h.tick();
  assert.equal(await h.alarmIn(), null, 'a handed-back turn waits on nothing, a link included');

  await h.accept(h.shortcut.prompt(SID, 'Safari'));
  await h.tick();
  h.fake.say(chat, 'Fixed it');
  chat.status = { kind: 'finished' };
  await h.tick();

  await h.accept(h.shortcut.prompt(SID, 'And Firefox?'));
  await h.tick();
  chat.status = { kind: 'failed', body: 'The Fake session ran out of budget.', keep: true };
  await h.tick();

  await h.accept(h.shortcut.prompt(SID, 'Anyone there?'));
  await h.tick();
  chat.status = { kind: 'pending' };
  for (let i = 0; i < 20 && h.bodies('error').length < 2; i++) await h.tick();

  await h.accept(h.shortcut.prompt(SID, 'Once more'));
  await h.tick();
  await h.accept(h.shortcut.stop(SID));
  await h.tick();

  assert.deepEqual(h.shortcut.activities().filter((a) => !a.key.endsWith(':ack')).map((a) => [a.content.type, a.content.body]), [
    ['thought', 'Looking into it'],
    ['elicitation', 'Which browser?'],
    ['response', 'Fixed it'],
    ['error', 'The Fake session ran out of budget.'],
    ['error', 'Fake did not pick up your reply. Reply to try again.'],
    ['response', 'Stopped.'],
  ]);
  assert.deepEqual(chat.received, ['Safari', 'And Firefox?', 'Anyone there?', 'Once more']);
  assert.deepEqual(h.requests.filter((r) => r.method === 'PATCH'), [], 'the card link is never written');
  assert.deepEqual(h.shortcut.sessions.get(SID).external_urls, []);
  assert.equal(await h.alarmIn(), null);
  h.assertCleanLogs();
});

it('answers a stop the backend keeps without claiming termination, and sends the next reply to the same conversation', async (t) => {
  const h = setup(t);
  h.fake.facts.keeps = true;
  const chat = await h.started();
  h.fake.say(chat, 'Working on it');
  await h.tick();
  await h.accept(h.shortcut.stop(SID));
  await h.tick();
  assert.equal(chat.halted, true);
  assert.deepEqual(h.bodies('response'), ['Stopped.'], 'the conversation has a URL, and the response still names nothing terminated');
  assert.equal(await h.alarmIn(), null, 'a kept conversation is not retired');

  await h.accept(h.shortcut.prompt(SID, 'Try Chrome instead'));
  await h.tick();
  assert.equal(h.calls('open').length, 1, 'the reply opens no new conversation');
  assert.deepEqual(h.fake.only().received, ['Try Chrome instead']);
  assert.equal(h.shortcut.activities().find((a) => a.key === 'fake-bridge:2:ack').content.body, 'Passing your message to Fake.');
  h.fake.say(chat, 'Chrome works');
  chat.status = { kind: 'finished' };
  await h.tick();
  assert.deepEqual(h.shortcut.activities().filter((a) => a.content.type === 'response').map((a) => [a.turn, a.content.body.split('\n')[0]]), [[1, 'Stopped.'], [2, 'Chrome works']]);
  assert.equal(h.calls('halt').length, 1);
  h.assertCleanLogs();
});

it('relays the replies that waited on a kept stop to the same conversation, after the halt', async (t) => {
  const h = setup(t);
  h.fake.facts.keeps = true;
  const chat = await h.started();
  await h.accept(h.shortcut.stop(SID));
  await h.accept(h.shortcut.prompt(SID, 'Try Chrome instead'));
  await h.tick();
  assert.deepEqual(h.fake.only().received, ['Try Chrome instead']);
  assert.deepEqual(h.requests.filter((r) => r.origin === 'fake').map((r) => r.method), ['open', 'halt', 'prepare', 'send']);
  assert.deepEqual(h.bodies('response'), [], 'the stop has no answer of its own once a reply replaced its turn');
  assert.deepEqual(h.shortcut.activities().filter((a) => a.turn === 2).map((a) => a.content.body), ['Passing your message to Fake.'], 'the reply is never said to start a new session');
  chat.status = { kind: 'finished' };
  await h.tick();
  assert.deepEqual(h.shortcut.activities().filter((a) => a.content.type === 'response').map((a) => [a.turn, a.content.body.split('\n')[0]]), [[2, 'Fake finished.']]);

  const slow = setup(t);
  slow.fake.facts.keeps = true;
  await slow.started();
  await slow.accept(slow.shortcut.stop(SID));
  await slow.accept(slow.shortcut.prompt(SID, 'Try Chrome instead'));
  slow.fake.failNext('halt', new BackendError({ kind: 'transient' }));
  await slow.ticks(2);
  assert.deepEqual(slow.fake.only().received, ['Try Chrome instead']);
  assert.deepEqual(slow.shortcut.activities().filter((a) => a.turn === 2).map((a) => [a.key, a.content.body]), [
    ['fake-bridge:2:ack', 'Starting a new Fake session.'],
    ['fake-bridge:2:ack:kept', 'Passing your message to Fake.'],
  ], 'an ack posted before the halt was answered is corrected under its own key');
  slow.assertCleanLogs();
});

it('halts again and relays the waiting reply once when the step dies after a kept halt', async (t) => {
  const h = setup(t);
  h.fake.facts.keeps = true;
  await h.started();
  await h.accept(h.shortcut.stop(SID));
  await h.accept(h.shortcut.prompt(SID, 'Try Chrome instead'));
  const died = dieAtSaveAfter(h, () => h.calls('halt').length === 1);
  await h.tick();
  assert.ok(died(), 'the step died at its save after the halt');
  assert.deepEqual(h.fake.only().received, []);
  await h.tick();
  assert.equal(h.calls('halt').length, 2, 'the halt is repeated, and a conversation already stopped answers kept again');
  assert.deepEqual(h.fake.only().received, ['Try Chrome instead']);
});

it('halts a kept conversation once when Shortcut closes the session, and ignores what follows', async (t) => {
  const h = setup(t);
  h.fake.facts.keeps = true;
  const chat = await h.started();
  h.fake.say(chat, 'Working on it');
  h.shortcut.sessions.get(SID).closed = true;
  await h.tick();
  assert.equal(chat.halted, true);
  assert.equal(await h.alarmIn(), null, 'a kept answer finishes the retirement');
  await h.accept(h.shortcut.prompt(SID, 'Anyone there?'));
  await h.tick();
  assert.equal(h.calls('halt').length, 1);
  assert.deepEqual(chat.received, []);
  assert.equal(h.calls('open').length, 1);
  h.assertCleanLogs();
});
