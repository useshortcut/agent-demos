// Races between Shortcut's events and a step that is already running, against
// fake-backend.ts. Runs in the `npm test` of the bridge in the current
// directory, against its src/core. exhaust.mjs searches the same races. Each
// test here shows one as a user would meet it.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { CONTEXT, REQUEST, SID, bridgeHarness, openingText } from './harness.mjs';

const root = pathToFileURL(`${process.cwd()}/`);
assert.ok(existsSync(new URL('src/core/port.ts', root)), 'races.test.mjs tests the bridge in the current directory. Run `npm test` inside a bridge.');

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
    bodies: (type) => h.shortcut.activities().filter((a) => a.content.type === type).map((a) => a.content.body),
  });
}

/** Shortcut delivers `event`, and has the bridge's 200, while the next `call` of `target` is out. */
function arrivesDuring(h, target, call, event) {
  const run = target[call];
  target[call] = async (...args) => {
    target[call] = run;
    const answer = await run.apply(target, args);
    await h.accept(event);
    return answer;
  };
}

it('applies a stop that arrives while a step waits on the backend before the step\'s next call, so the reply it cancels is never sent', async (t) => {
  const h = setup(t);
  const chat = await h.started();
  await h.accept(h.shortcut.prompt(SID, 'cancel this reply'));
  arrivesDuring(h, h.fake.backend, 'prepare', h.shortcut.stop(SID));
  await h.tick();
  assert.deepEqual(chat.received, [], 'the stop was acknowledged before the send went out');
  assert.equal(chat.halted, true, 'the step that was running halts the conversation');
  assert.deepEqual(h.bodies('response'), [`Stopped. The Fake session was terminated: ${chat.url}`]);
  assert.equal(await h.alarmIn(), null);
  h.assertCleanLogs();
});

it('applies a stop that arrives while a step loads the Shortcut credentials before the send that step was about to retry', async (t) => {
  const h = setup(t);
  const chat = await h.started();
  await h.accept(h.shortcut.prompt(SID, 'cancel this reply'));
  h.fake.failNext('send', new BackendError({ kind: 'transient' }));
  await h.tick();
  assert.deepEqual([h.calls('send').length, chat.received], [1, []], 'the send is prepared and has failed once');

  const workspaces = h.env.WORKSPACES;
  const { get } = workspaces;
  workspaces.get = (id) => {
    workspaces.get = get;
    const workspace = get(id);
    arrivesDuring(h, workspace, 'fetch', h.shortcut.stop(SID));
    return workspace;
  };
  await h.tick();
  assert.deepEqual([h.calls('send').length, chat.received], [1, []], 'the send is not tried again');
  assert.equal(chat.halted, true);
  h.assertCleanLogs();
});

it('opens the conversation with the opening request when the user replies before the bridge has acknowledged turn 1, and sends the reply there', async (t) => {
  const h = setup(t);
  await h.connect();
  const created = h.shortcut.open();
  const reply = h.shortcut.prompt(SID, 'Also examine Firefox');
  await h.accept(created);
  await h.tick();
  const chat = h.fake.only();
  assert.equal(chat.opened, openingText(REQUEST), 'Shortcut refused the acknowledgement of turn 1, and the request still went out');
  await h.accept(reply);
  await h.tick();
  assert.deepEqual(chat.received, ['Also examine Firefox']);
  assert.deepEqual(h.shortcut.activities().map((a) => [a.key, a.content.body]), [['fake-bridge:2:ack', 'Passing your message to Fake.']]);
  assert.equal(h.calls('open').length, 1);
  h.assertCleanLogs();
});

it('opens nothing for an opening request whose turn Shortcut ended on its own before the bridge acknowledged it', async (t) => {
  const h = setup(t);
  await h.connect();
  await h.accept(h.shortcut.open());
  h.shortcut.failTurn(SID);
  await h.tick();
  assert.deepEqual(h.fake.chats, []);
  assert.equal(await h.alarmIn(), null);
});

// The bridge started from a reply and the agent is at work. The session.created that follows brings a context and no request, so the context would go alone.
async function lateContext(h) {
  await h.connect();
  const created = h.shortcut.open(SID, { body: '' });
  await h.accept(h.shortcut.prompt(SID, 'Start here'));
  await h.tick();
  return { chat: h.fake.only(), created };
}

it('posts the answer of an agent that finished before a late context could go to it alone, and sends the context with the next reply', async (t) => {
  const h = setup(t);
  const { chat, created } = await lateContext(h);
  h.fake.say(chat, 'All done');
  chat.status = { kind: 'finished' };
  await h.accept(created);
  await h.tick();
  assert.deepEqual(chat.received, [], 'the context is not sent past an answer the bridge has not read');
  assert.deepEqual(h.bodies('response'), [`All done\n\n[Open in Fake](${chat.url})`]);
  assert.deepEqual(h.bodies('error'), []);
  assert.equal(await h.alarmIn(), null);

  await h.accept(h.shortcut.prompt(SID, 'One more thing'));
  await h.tick();
  assert.deepEqual(chat.received, [`Context from Shortcut:\n\n${CONTEXT}\n\nOne more thing`]);
  h.assertCleanLogs();
});

it('sends a late context alone to an agent it has just read as still working', async (t) => {
  const h = setup(t);
  const { chat, created } = await lateContext(h);
  await h.accept(created);
  await h.tick();
  assert.deepEqual(chat.received, [`Context from Shortcut:\n\n${CONTEXT}`]);
  assert.deepEqual(h.requests.filter((r) => r.origin === 'fake').map((r) => r.method).slice(-3), ['prepare', 'observe', 'send']);
  assert.deepEqual(h.bodies('response'), []);
});

it('reads the agent again before it retries a send that carries only the context, and posts an answer given since the first try', async (t) => {
  const h = setup(t);
  const { chat, created } = await lateContext(h);
  await h.accept(created);
  h.fake.failNext('send', new BackendError({ kind: 'transient' }));
  await h.tick();
  assert.deepEqual([h.calls('send').length, chat.received], [1, []]);
  h.fake.say(chat, 'All done');
  chat.status = { kind: 'finished' };
  await h.tick();
  assert.deepEqual([h.calls('send').length, chat.received], [1, []], 'the send is not tried again');
  assert.deepEqual(h.bodies('response'), [`All done\n\n[Open in Fake](${chat.url})`]);
});

it('ends no turn when the backend refuses the read before a send that carries only the context, and goes on polling', async (t) => {
  const h = setup(t);
  const { chat, created } = await lateContext(h);
  await h.accept(created);
  h.fake.failNext('observe', new BackendError({ kind: 'rejected', status: 401 }));
  await h.tick();
  assert.deepEqual([chat.received, h.bodies('error')], [[], []]);
  h.fake.say(chat, 'All done');
  chat.status = { kind: 'finished' };
  await h.tick();
  assert.deepEqual(h.bodies('response'), [`All done\n\n[Open in Fake](${chat.url})`]);
  assert.deepEqual(chat.received, []);
});

// A session whose stop of turn 1 Shortcut has not delivered yet.
async function withLateStop(h) {
  await h.connect();
  const created = h.shortcut.open();
  const stop = h.shortcut.stop(SID);
  h.shortcut.sessions.get(SID).stopRequested = false;
  return { created, stop };
}

it('halts nothing for a stop that arrives after a newer reply reached the agent, and sends the reply that waited to the same conversation', async (t) => {
  const h = setup(t);
  const { created, stop } = await withLateStop(h);
  await h.accept(created);
  await h.tick();
  const chat = h.fake.only();
  await h.accept(h.shortcut.prompt(SID, 'Second'));
  await h.tick();
  assert.deepEqual(chat.received, ['Second']);
  await h.accept(h.shortcut.prompt(SID, 'Third'));
  await h.accept(stop);
  await h.tick();
  assert.equal(h.calls('halt').length, 0, 'the agent keeps what it did with the second request');
  assert.deepEqual(chat.received, ['Second', 'Third']);
  assert.equal(h.fake.chats.length, 1);
  assert.deepEqual(h.bodies('thought').filter((body) => /new Fake session/.test(body)), []);
  h.assertCleanLogs();
});

it('still halts the conversation for a stop that arrives before the reply after it was sent, and opens a new one with that reply', async (t) => {
  const h = setup(t);
  const { created, stop } = await withLateStop(h);
  await h.accept(created);
  await h.tick();
  const first = h.fake.only();
  await h.accept(h.shortcut.prompt(SID, 'Second'));
  await h.accept(stop);
  await h.tick();
  assert.equal(first.halted, true, 'the agent held only the request the stop cancelled');
  assert.deepEqual(first.received, []);
  assert.equal(h.fake.chats.length, 2);
  assert.match(h.fake.chats[1].opened, /Second/);
});

it('sends a reply again, in a new message to the same conversation, when a stale stop cancels the opening request that was to go with it', async (t) => {
  const h = setup(t);
  const { created, stop } = await withLateStop(h);
  await h.accept(h.shortcut.prompt(SID, 'Second'));
  await h.tick();
  const chat = h.fake.only();
  await h.accept(created);
  await h.accept(h.shortcut.prompt(SID, 'Third'));
  h.fake.failNext('send', new BackendError({ kind: 'transient' }));
  await h.tick();
  assert.deepEqual([h.calls('send').length, chat.received], [1, []], 'the message with the opening request and the third reply is prepared and has failed once');
  await h.accept(stop);
  await h.tick();
  await h.tick();
  assert.equal(h.calls('halt').length, 0);
  assert.deepEqual(chat.received, [`Context from Shortcut:\n\n${CONTEXT}\n\nThird`], 'the cancelled opening request is gone, and the reply and the context are not');
  assert.equal(h.fake.chats.length, 1);
});

/** Shortcut holds every event of the session from the start. `on(turn)` puts its session on the turn of the event it delivers next. */
async function heldEvents(h) {
  await h.connect();
  h.shortcut.open();
  const events = { stop: {}, reply: {} };
  for (const turn of [2, 3, 4]) {
    events.reply[turn] = h.shortcut.prompt(SID, `Reply ${turn}`);
    events.stop[turn] = h.shortcut.stop(SID);
  }
  const on = (turn) => Object.assign(h.shortcut.sessions.get(SID), { turn, stopRequested: false, outcome: null, status: 'active' });
  return { events, on };
}

it('still halts a conversation that replaced one that ended, for a stop newer than all it holds, though the ended one had taken a newer reply', async (t) => {
  const h = setup(t);
  const { events, on } = await heldEvents(h);
  on(3);
  await h.accept(events.reply[3]);
  h.fake.failNext('open', new BackendError({ kind: 'transient' }));
  await h.tick();
  await h.accept(events.reply[2]);
  // The first conversation takes reply 3 and ends on its own before reply 2 can follow.
  const { backend } = h.fake;
  const { open } = backend;
  backend.open = async (request) => {
    backend.open = open;
    const opened = await open(request);
    h.fake.chats[0].gone = true;
    return opened;
  };
  await h.tick();
  await h.tick();
  const [first, second] = h.fake.chats;
  assert.match(first.opened, /Reply 3/);
  assert.match(second.opened, /Reply 2/);
  assert.doesNotMatch(second.opened, /Reply 3/);

  on(4);
  await h.accept(events.reply[4]);
  await h.accept(events.stop[2]);
  await h.tick();
  await h.tick();
  assert.equal(second.halted, true, 'the second conversation held only the reply the stop cancelled');
  assert.deepEqual(second.received, []);
  assert.match(h.fake.chats[2].opened, /Reply 4/);
});
