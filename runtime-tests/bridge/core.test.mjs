// The core paths no real backend's tests reach, against fake-backend.ts. Runs
// in the `npm test` of the bridge in the current directory, against its src/core.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { conform } from './conform.mjs';
import { CONTEXT, REQUEST, SID, assertAbout, bridgeHarness, openingText } from './harness.mjs';

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
  t.after(() => assert.deepEqual(h.vendor.misuse, []));
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
  assert.equal(chat.opened, openingText(REQUEST));
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

it('writes no card link for a conversation without a URL that follows one with a link', async (t) => {
  const h = setup(t);
  const first = await h.started();
  assert.deepEqual(h.shortcut.sessions.get(SID).external_urls, [{ label: 'Open in Fake', url: first.url }]);
  h.fake.facts.linked = false;
  await h.accept(h.shortcut.stop(SID));
  await h.tick();
  await h.accept(h.shortcut.prompt(SID, 'Try Chrome instead'));
  await h.tick();
  assert.equal(h.fake.chats[1].url, null);
  assert.equal(h.requests.filter((r) => r.method === 'PATCH').length, 1, 'the only link written is the first conversation\'s');
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

it('repeats a send under the same key and text when the step dies before saving it, and gives the next send another key', async (t) => {
  const h = setup(t);
  const chat = await h.started();
  chat.status = { kind: 'finished' };
  await h.tick();
  await h.accept(h.shortcut.prompt(SID, 'Also fix Firefox'));
  const died = dieAtSaveAfter(h, () => h.calls('send').length === 1);
  await h.tick();
  assert.ok(died(), 'the step died at its save after the send');
  await h.tick();
  assert.equal(chat.sends.length, 2, 'the send is repeated');
  assert.deepEqual(chat.sends[1], chat.sends[0], 'under the same key, with the same text');
  assert.deepEqual(chat.received, ['Also fix Firefox'], 'so a backend with idempotent sends delivers it once');
  assert.equal(h.calls('prepare').length, 1, 'what the send depends on is not read again');

  chat.status = { kind: 'finished' };
  await h.tick();
  await h.accept(h.shortcut.prompt(SID, 'And Edge'));
  h.fake.failNext('send', new BackendError({ kind: 'transient' }), { landed: true });
  await h.ticks(2);
  assert.deepEqual(chat.sends.map((sent) => sent.text), ['Also fix Firefox', 'Also fix Firefox', 'And Edge', 'And Edge']);
  assert.equal(chat.sends[3].key, chat.sends[2].key, 'a send whose answer was lost is retried under its key');
  assert.notEqual(chat.sends[2].key, chat.sends[0].key, 'another send has another key');
  assert.deepEqual(chat.received, ['Also fix Firefox', 'And Edge']);
});

it('sends a reply again under a new key after a stop interrupted the conversation it was sent to', async (t) => {
  const h = setup(t);
  h.fake.facts.keeps = true;
  const chat = await h.started();
  const stop = h.shortcut.stop(SID);
  await h.accept(h.shortcut.prompt(SID, 'Try Chrome instead'));
  h.fake.failNext('send', new BackendError({ kind: 'transient' }), { landed: true });
  await h.tick();
  assert.deepEqual(chat.received, ['Try Chrome instead']);
  await h.accept(stop);
  await h.ticks(2);
  assert.deepEqual(h.requests.filter((r) => r.origin === 'fake').map((r) => r.method).slice(-3), ['halt', 'prepare', 'send']);
  assert.notEqual(chat.sends[1].key, chat.sends[0].key, 'the send after the halt is a new send, though its text is the same');
  assert.deepEqual(chat.received, ['Try Chrome instead', 'Try Chrome instead'], 'so the reply reaches the agent after the interrupt');
});

it('introduces a conversation opened empty with its first send, and sends later replies as they are', async (t) => {
  const h = setup(t);
  h.fake.facts.empty = true;
  const chat = await h.started();
  assert.equal(chat.opened, null);
  assert.deepEqual(chat.received, [openingText(REQUEST)], 'the first message is the opening text an open would have carried');
  assert.deepEqual(h.requests.filter((r) => r.origin === 'fake').map((r) => r.method), ['open', 'prepare', 'send']);
  assert.deepEqual(h.shortcut.sessions.get(SID).external_urls, [{ label: 'Open in Fake', url: chat.url }]);
  h.fake.say(chat, 'Fixed it');
  chat.status = { kind: 'finished' };
  await h.tick();
  await h.accept(h.shortcut.prompt(SID, 'Also fix Firefox'));
  await h.tick();
  assert.deepEqual(chat.received, [openingText(REQUEST), 'Also fix Firefox'], 'only the first message introduces');
  assert.deepEqual(h.bodies('response').map((body) => body.split('\n')[0]), ['Fixed it']);
  h.assertCleanLogs();

  const bare = setup(t);
  bare.fake.facts.empty = true;
  await bare.connect();
  await bare.accept(bare.shortcut.open(SID, { body: { type: 'attachment' } }));
  await bare.tick();
  assert.deepEqual(bare.fake.only().received, [openingText('')], 'a session opened without text is introduced by the story alone');
});

it('puts the replies that arrived during an empty open into the introduction, in turn order', async (t) => {
  const h = setup(t);
  h.fake.facts.empty = true;
  await h.connect();
  await h.accept(h.shortcut.open());
  h.fake.failNext('open', new BackendError({ kind: 'transient' }));
  await h.tick();
  await h.accept(h.shortcut.prompt(SID, 'Also fix Firefox'));
  await h.ticks(2);
  const chat = h.fake.only();
  assert.deepEqual(chat.received, [openingText(`${REQUEST}\n\nAlso fix Firefox`)]);
  h.fake.say(chat, 'Fixed both');
  chat.status = { kind: 'finished' };
  await h.tick();
  assert.deepEqual(h.shortcut.activities().filter((a) => a.content.type === 'response').map((a) => [a.turn, a.content.body.split('\n')[0]]), [[2, 'Fixed both']]);
});

it('opens again when the step dies after an empty open, and introduces only the conversation it kept', async (t) => {
  const h = setup(t);
  h.fake.facts.empty = true;
  await h.connect();
  await h.accept(h.shortcut.open());
  const died = dieAtSaveAfter(h, () => h.calls('open').length === 1);
  await h.tick();
  assert.ok(died(), 'the step died at its save after the open');
  await h.tick();
  assert.deepEqual(h.fake.chats.map((chat) => chat.received), [[], [openingText(REQUEST)]], 'the conversation the lost open made was told nothing, so it runs nothing');
  assert.equal(h.calls('halt').length, 0);
});

it('repeats the introduction under the same key and text when the step dies after sending it', async (t) => {
  const h = setup(t);
  h.fake.facts.empty = true;
  await h.connect();
  await h.accept(h.shortcut.open());
  const died = dieAtSaveAfter(h, () => h.calls('send').length === 1);
  await h.tick();
  assert.ok(died(), 'the step died at its save after the send');
  await h.tick();
  const chat = h.fake.only();
  assert.equal(chat.sends.length, 2, 'the introduction is sent again');
  assert.deepEqual(chat.sends[1], chat.sends[0]);
  assert.deepEqual(chat.received, [openingText(REQUEST)]);
  assert.equal(h.calls('open').length, 1, 'the conversation it was sent to is kept');
});

it('answers a stop while an empty open is unresolved without halting anything, and the next reply opens and introduces a new conversation', async (t) => {
  const h = setup(t);
  h.fake.facts.empty = true;
  await h.connect();
  await h.accept(h.shortcut.open());
  h.fake.failNext('open', new BackendError({ kind: 'transient' }), { landed: true });
  await h.tick();
  await h.accept(h.shortcut.stop(SID));
  await h.ticks(2);
  assert.deepEqual(h.bodies('response'), ['Stopped.']);
  assert.deepEqual(h.fake.chats.map((chat) => [chat.halted, chat.received]), [[false, []]]);
  assert.equal(await h.alarmIn(), null, 'nothing is looked up again');

  await h.accept(h.shortcut.prompt(SID, 'Try Chrome instead'));
  await h.tick();
  assert.deepEqual(h.fake.chats.map((chat) => [chat.key, chat.received]), [
    ['shortcut-session-sess-1-1', []],
    ['shortcut-session-sess-1-2', [openingText('Try Chrome instead')]],
  ]);
  h.assertCleanLogs();
});

it('still introduces a kept conversation whose first send was stopped before it went out', async (t) => {
  const h = setup(t);
  Object.assign(h.fake.facts, { empty: true, keeps: true });
  await h.connect();
  await h.accept(h.shortcut.open());
  h.fake.failNext('prepare', new BackendError({ kind: 'transient' }));
  await h.tick();
  await h.accept(h.shortcut.stop(SID));
  await h.ticks(2);
  assert.deepEqual(h.bodies('response'), ['Stopped.']);
  const chat = h.fake.only();
  assert.deepEqual(chat.received, [], 'the stopped request never went out');

  await h.accept(h.shortcut.prompt(SID, 'Try Chrome instead'));
  await h.tick();
  assert.deepEqual(chat.received, [openingText('Try Chrome instead')], 'the first message the conversation gets is an introduction, whichever relay sends it');
  chat.status = { kind: 'finished' };
  await h.tick();
  await h.accept(h.shortcut.prompt(SID, 'And Edge'));
  await h.tick();
  assert.deepEqual(chat.received, [openingText('Try Chrome instead'), 'And Edge']);
});

for (const [lost, lose] of [
  ['its answer was lost', (h) => h.fake.failNext('send', new BackendError({ kind: 'transient' }), { landed: true })],
  ['the step died before saving it', (h) => dieAtSaveAfter(h, () => h.calls('send').length === 1)],
]) {
  it(`sends the reply after a kept stop as it is when the introduction reached the conversation and ${lost}`, async (t) => {
    const h = setup(t);
    Object.assign(h.fake.facts, { empty: true, keeps: true });
    await h.connect();
    await h.accept(h.shortcut.open());
    lose(h);
    await h.tick();
    const chat = h.fake.only();
    assert.deepEqual(chat.received, [openingText(REQUEST)]);
    await h.accept(h.shortcut.stop(SID));
    await h.ticks(2);
    assert.deepEqual(h.bodies('response'), ['Stopped.']);

    await h.accept(h.shortcut.prompt(SID, 'Try Chrome instead'));
    await h.ticks(2);
    assert.deepEqual(chat.received, [openingText(REQUEST), 'Try Chrome instead'], 'the backend says the conversation holds a message, so it is not introduced a second time');
  });
}

it('ends the turn when an empty conversation is gone before its first message, and opens another only for the next reply', async (t) => {
  const h = setup(t);
  h.fake.facts.empty = true;
  await h.connect();
  await h.accept(h.shortcut.open());
  h.fake.failNext('prepare', new BackendError({ kind: 'transient' }));
  await h.tick();
  h.fake.only().gone = true;
  await h.ticks(2);
  assert.equal(h.calls('open').length, 1, 'a conversation that was told nothing is not replaced by another in the same position');
  assert.deepEqual(h.bodies('error'), ['The Fake session ended before it took your message. Reply to start a new one.']);
  assert.equal(await h.alarmIn(), null);

  await h.accept(h.shortcut.prompt(SID, 'Try again'));
  await h.tick();
  assert.deepEqual(h.fake.chats.map((chat) => chat.received), [[], [openingText('Try again')]]);
});

for (const [window, failing] of [['before the open is attempted', null], ['while the open is unresolved', 'open'], ['before the introduction is prepared', 'prepare']]) {
  it(`puts a session.created delivered after a reply into the introduction of an empty conversation when it arrives ${window}`, async (t) => {
    const h = setup(t);
    h.fake.facts.empty = true;
    await h.connect();
    const created = h.shortcut.open();
    await h.accept(h.shortcut.prompt(SID, 'Pick this up'));
    if (failing) {
      h.fake.failNext(failing, new BackendError({ kind: 'transient' }));
      await h.tick();
    }
    await h.accept(created);
    await h.ticks(2);
    assert.deepEqual(h.fake.only().received, [openingText(`${REQUEST}\n\nPick this up`)], 'the request and the context reach the agent once, in the one introduction');
    h.assertCleanLogs();
  });
}

it('puts a late session.created into an introduction that is not prepared yet, whatever replies arrived meanwhile', async (t) => {
  const h = setup(t);
  h.fake.facts.empty = true;
  await h.connect();
  const created = h.shortcut.open();
  await h.accept(h.shortcut.prompt(SID, 'Pick this up'));
  h.fake.failNext('prepare', new BackendError({ kind: 'transient' }));
  await h.tick();
  await h.accept(h.shortcut.prompt(SID, 'Also fix Firefox'));
  await h.accept(created);
  await h.ticks(2);
  assert.deepEqual(h.fake.only().received, [openingText(`${REQUEST}\n\nPick this up\n\nAlso fix Firefox`)], 'nothing had reached the agent, so the request is not dropped for the newer reply');
});

it('keeps the opening request of a session.created that arrives while an empty open is unresolved, whatever replies arrived meanwhile', async (t) => {
  const h = setup(t);
  h.fake.facts.empty = true;
  await h.connect();
  const created = h.shortcut.open();
  await h.accept(h.shortcut.prompt(SID, 'Pick this up'));
  h.fake.failNext('open', new BackendError({ kind: 'transient' }));
  await h.tick();
  await h.accept(h.shortcut.prompt(SID, 'Also fix Firefox'));
  await h.accept(created);
  await h.ticks(2);
  assert.deepEqual(h.fake.only().received, [openingText(`${REQUEST}\n\nPick this up\n\nAlso fix Firefox`)], 'the open answered that nothing had reached the agent, so the request is in the introduction');
});

it('drops the opening request of a session.created that arrived while an open was unresolved once the open answers that its text went out', async (t) => {
  const h = setup(t);
  await h.connect();
  const created = h.shortcut.open();
  await h.accept(h.shortcut.prompt(SID, 'Pick this up'));
  h.fake.failNext('open', new BackendError({ kind: 'transient' }), { landed: true });
  await h.tick();
  await h.accept(h.shortcut.prompt(SID, 'Also fix Firefox'));
  await h.accept(created);
  await h.ticks(2);
  const chat = h.fake.only();
  assert.equal(chat.opened, openingText('Pick this up', ''));
  assert.deepEqual(chat.received, [`Context from Shortcut:\n\n${CONTEXT}\n\nAlso fix Firefox`], 'a newer reply had reached the agent, so the request is superseded and only its context follows');
});

it('relays a session.created that arrives after the introduction was prepared as a message of its own, with the context under it', async (t) => {
  const h = setup(t);
  h.fake.facts.empty = true;
  await h.connect();
  const created = h.shortcut.open();
  await h.accept(h.shortcut.prompt(SID, 'Pick this up'));
  h.fake.failNext('send', new BackendError({ kind: 'transient' }));
  await h.tick();
  await h.accept(created);
  await h.ticks(2);
  assert.deepEqual(h.fake.only().received, [
    openingText('Pick this up', ''),
    `${REQUEST}\n\nContext from Shortcut:\n\n${CONTEXT}`,
  ], 'the introduction goes out as it was prepared, and the request follows it');
});

it('sends only the context of a session.created that arrives after the first turn was answered, ahead of the next reply to an introduced conversation', async (t) => {
  const h = setup(t);
  h.fake.facts.empty = true;
  await h.connect();
  const created = h.shortcut.open();
  await h.accept(h.shortcut.prompt(SID, 'Pick this up'));
  await h.tick();
  const chat = h.fake.only();
  chat.status = { kind: 'finished' };
  await h.tick();
  await h.accept(created);
  await h.tick();
  await h.accept(h.shortcut.prompt(SID, 'Next'));
  await h.tick();
  assert.deepEqual(chat.received, [openingText('Pick this up', ''), `Context from Shortcut:\n\n${CONTEXT}\n\nNext`]);
});

it('carries the context of a late session.created once, in the introduction, when the conversation is still empty after a stop', async (t) => {
  const h = setup(t);
  Object.assign(h.fake.facts, { empty: true, keeps: true });
  await h.connect();
  const created = h.shortcut.open();
  await h.accept(h.shortcut.prompt(SID, 'Pick this up'));
  h.fake.failNext('prepare', new BackendError({ kind: 'transient' }));
  await h.tick();
  await h.accept(h.shortcut.stop(SID));
  await h.ticks(2);
  await h.accept(created);
  await h.tick();
  await h.accept(h.shortcut.prompt(SID, 'Try Chrome instead'));
  await h.tick();
  assert.deepEqual(h.fake.only().received, [openingText('Try Chrome instead')], 'the stopped request does not come back, and the context is not sent a second time ahead of the reply');
});

it('keeps a stopped opening request cancelled when its session.created arrives before the next reply is introduced', async (t) => {
  const h = setup(t);
  Object.assign(h.fake.facts, { empty: true, keeps: true });
  await h.connect();
  const created = h.shortcut.open();
  await h.accept(h.shortcut.prompt(SID, 'Pick this up'));
  h.fake.failNext('prepare', new BackendError({ kind: 'transient' }));
  await h.tick();
  await h.accept(h.shortcut.stop(SID));
  await h.ticks(2);
  assert.deepEqual(h.bodies('response'), ['Stopped.']);

  await h.accept(h.shortcut.prompt(SID, 'Try Chrome instead'));
  h.fake.failNext('prepare', new BackendError({ kind: 'transient' }));
  await h.tick();
  await h.accept(created);
  await h.ticks(2);
  assert.deepEqual(h.fake.only().received, [openingText('Try Chrome instead')], 'the stop cancelled the request, and its context still reaches the agent once');
});

it('keeps an opening request cancelled by a stop delivered after the reply that followed it', async (t) => {
  const h = setup(t);
  Object.assign(h.fake.facts, { empty: true, keeps: true });
  await h.connect();
  const created = h.shortcut.open();
  await h.accept(h.shortcut.prompt(SID, 'Pick this up'));
  h.fake.failNext('prepare', new BackendError({ kind: 'transient' }));
  await h.tick();
  const stop = h.shortcut.stop(SID);
  await h.accept(h.shortcut.prompt(SID, 'Also fix Firefox'));
  await h.accept(stop);
  h.fake.failNext('prepare', new BackendError({ kind: 'transient' }));
  await h.ticks(2);
  assert.equal(h.calls('halt').length, 1, 'the stop halted the conversation, and the backend kept it');
  await h.accept(created);
  await h.ticks(2);
  assert.deepEqual(h.fake.only().received, [openingText('Also fix Firefox')], 'the stop cancelled every turn up to its own, the opening request included');
});

it('sends only the context of a late session.created whose request a stop had cancelled, while the turn the bridge started on is still open', async (t) => {
  const h = setup(t);
  await h.connect();
  const created = h.shortcut.open();
  h.shortcut.prompt(SID, 'Pick this up');
  const stop = h.shortcut.stop(SID);
  await h.accept(h.shortcut.prompt(SID, 'Also fix Firefox'));
  await h.tick();
  const chat = h.fake.only();
  await h.accept(stop);
  await h.tick();
  assert.equal(h.calls('halt').length, 0, 'every reply after the stop was sent, so the stop halts nothing');
  await h.accept(created);
  await h.tick();
  assert.deepEqual(chat.received, [`Context from Shortcut:\n\n${CONTEXT}`], 'the stop still cancelled the request, and the agent learns the context at once');
});

it('still sends the late context a relay carried when a kept stop came before its send went through', async (t) => {
  const h = setup(t);
  h.fake.facts.keeps = true;
  await h.connect();
  const created = h.shortcut.open();
  await h.accept(h.shortcut.prompt(SID, 'Pick this up'));
  await h.tick();
  const chat = h.fake.only();
  chat.status = { kind: 'finished' };
  await h.tick();
  await h.accept(created);
  await h.accept(h.shortcut.prompt(SID, 'Next'));
  h.fake.failNext('send', new BackendError({ kind: 'transient' }));
  await h.tick();
  await h.accept(h.shortcut.stop(SID));
  await h.ticks(2);
  await h.accept(h.shortcut.prompt(SID, 'Again'));
  await h.tick();
  assert.deepEqual(chat.received, [`Context from Shortcut:\n\n${CONTEXT}\n\nAgain`], 'the conversation is kept, so it is still owed the context');
});

it('still sends the context of a late opening request that a kept stop cancelled before it went out', async (t) => {
  const h = setup(t);
  h.fake.facts.keeps = true;
  await h.connect();
  const created = h.shortcut.open();
  await h.accept(h.shortcut.prompt(SID, 'Pick this up'));
  await h.tick();
  const chat = h.fake.only();
  await h.accept(created);
  h.fake.failNext('send', new BackendError({ kind: 'transient' }));
  await h.tick();
  await h.accept(h.shortcut.stop(SID));
  await h.ticks(2);
  await h.accept(h.shortcut.prompt(SID, 'Again'));
  await h.tick();
  assert.deepEqual(chat.received, [`Context from Shortcut:\n\n${CONTEXT}\n\nAgain`], 'the request stays stopped, and the context under it goes ahead of the next reply');
});

it('still sends the context of a late opening request whose relay failed and ended the turn', async (t) => {
  const h = setup(t);
  await h.connect();
  const created = h.shortcut.open();
  await h.accept(h.shortcut.prompt(SID, 'Pick this up'));
  await h.tick();
  const chat = h.fake.only();
  await h.accept(created);
  h.fake.failNext('send', new BackendError({ kind: 'rejected', status: 401 }));
  await h.tick();
  assert.deepEqual(h.bodies('error'), ['Fake rejected the request (HTTP 401). Reply to try again.']);
  await h.accept(h.shortcut.prompt(SID, 'Again'));
  await h.tick();
  assert.deepEqual(chat.received, [`Context from Shortcut:\n\n${CONTEXT}\n\nAgain`], 'the turn took the request with it, and the conversation is still owed the context');
});

it('owes no context after a kept stop when the introduction that carried a late opening request reached the conversation', async (t) => {
  const h = setup(t);
  Object.assign(h.fake.facts, { empty: true, keeps: true });
  await h.connect();
  const created = h.shortcut.open();
  await h.accept(h.shortcut.prompt(SID, 'Pick this up'));
  h.fake.failNext('prepare', new BackendError({ kind: 'transient' }));
  await h.tick();
  await h.accept(created);
  h.fake.failNext('send', new BackendError({ kind: 'transient' }), { landed: true });
  await h.ticks(2);
  const chat = h.fake.only();
  assert.deepEqual(chat.received, [openingText(`${REQUEST}\n\nPick this up`)]);
  await h.accept(h.shortcut.stop(SID));
  await h.ticks(2);
  await h.accept(h.shortcut.prompt(SID, 'Try Chrome instead'));
  await h.ticks(2);
  assert.deepEqual(chat.received, [openingText(`${REQUEST}\n\nPick this up`), 'Try Chrome instead'], 'the introduction carried the context itself, so the stop leaves none to send');
});

// The conformance scenarios, for the kinds of backend no bridge here has yet.
for (const [label, facts] of [
  ['a backend that keeps its session, opens it empty, and has no link', { keeps: true, opensEmpty: true, linked: false }],
  ['a backend that keeps its session and opens it with the request', { keeps: true, opensEmpty: false, linked: true }],
]) {
  conform({
    label,
    setup(t) {
      const h = setup(t);
      Object.assign(h.fake.facts, { keeps: facts.keeps, empty: facts.opensEmpty, linked: facts.linked });
      return h;
    },
    identity: { slug: 'fake-bridge', name: 'Fake', aSession: 'a Fake session', linkLabel: 'Open in Fake' },
    facts,
    vendor: {
      sessions: (h) => h.fake.chats,
      told: (h, chat) => ({ opened: chat.opened, messages: chat.received }),
      url: (chat) => chat.url,
      work: (h, chat) => { chat.status = { kind: 'working' }; },
      say: (h, chat, text) => h.fake.say(chat, text),
      finish: (h, chat) => { chat.status = { kind: 'finished' }; },
      ask(h, chat, question) {
        h.fake.say(chat, question);
        chat.status = { kind: 'asked', on: 'user' };
      },
      fail: (h, chat) => { chat.status = { kind: 'failed', body: 'The Fake session failed.', keep: false }; },
      halted: (h, chat) => chat.halted,
    },
  });
}
