import assert from 'node:assert/strict';
import { it } from 'node:test';
import { SID, openingText, setup, typed, until } from './harness.mjs';

it('interrupts the session on a stop, keeps it, and sends the next reply to it', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.claude.say(session, 'Working on it');
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  await until(h, () => typed(h, 'response').length > 0, 'answers the stop');
  assert.deepEqual(typed(h, 'response'), [[1, 'Stopped.']]);
  assert.deepEqual(h.sent().map((event) => event.type), ['user.message', 'user.interrupt']);
  assert.deepEqual(h.sent()[1], { type: 'user.interrupt' });
  assert.equal(h.requests.filter((r) => r.origin === 'claude' && r.method === 'DELETE').length, 0, 'the session is never deleted');

  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Try Chrome instead'))).status, 200);
  await until(h, () => session.received.length === 2, 'sends the reply');
  assert.deepEqual(h.claude.sessions.length, 1);
  assert.deepEqual(h.sent().at(-1), { type: 'user.message', content: [{ type: 'text', text: 'Try Chrome instead' }] });
  h.claude.say(session, 'Chrome works');
  h.claude.finish(session);
  await until(h, () => typed(h, 'response').length === 2, 'answers the reply, not the interrupted turn');
  assert.deepEqual(typed(h, 'response').map(([turn, body]) => [turn, body.split('\n')[0]]), [[1, 'Stopped.'], [2, 'Chrome works']]);
  h.assertCleanLogs();
});

it('keeps an ask_user call open across a stop, and answers it with the next reply', async (t) => {
  const h = setup(t);
  const session = await h.started();
  const call = h.claude.ask(session, 'Which browser?');
  await until(h, () => typed(h, 'elicitation').length > 0, 'asks');
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  await until(h, () => typed(h, 'response').length > 0, 'answers the stop');
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Safari'))).status, 200);
  await until(h, () => session.received.length === 2, 'answers the call');
  assert.deepEqual(h.sent().at(-1), { type: 'user.custom_tool_result', custom_tool_use_id: call.id, content: [{ type: 'text', text: 'Safari' }] });
  assert.deepEqual(typed(h, 'error'), []);
});

it('counts a stop of a session Claude no longer has as stopped, and opens a new one for the reply', async (t) => {
  const h = setup(t, { linked: false });
  const session = await h.started();
  h.claude.work(session);
  h.claude.failNext(404, {}, /^POST \/v1\/sessions\/[^/]+\/events$/);
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  await until(h, () => typed(h, 'response').length > 0, 'answers the stop');
  assert.deepEqual([typed(h, 'response'), typed(h, 'error')], [[[1, 'Stopped.']], []]);
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Try again'))).status, 200);
  await until(h, () => h.claude.sessions.length === 2 && h.claude.sessions[1].received.length > 0, 'opens a new session');
  assert.deepEqual(h.claude.sessions[1].received, [openingText('Try again')]);
});

it('interrupts the session when Shortcut closes it', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.claude.work(session);
  h.shortcut.sessions.get(SID).closed = true;
  await until(h, () => session.interrupts > 0, 'interrupts');
  assert.deepEqual(h.sent().map((event) => event.type), ['user.message', 'user.interrupt']);
  assert.notEqual(session.status, 'terminated');
});

it('retires a terminated session with one interrupt, taking its refusal as done', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.claude.terminate(session);
  await until(h, () => typed(h, 'error').length > 0, 'reports the termination');
  for (let i = 0; i < 6; i++) await h.tick();
  assert.equal(h.sent().filter((event) => event.type === 'user.interrupt').length, 1);
  assert.deepEqual(h.logs.filter(([level]) => level === 'warn'), []);
});

const queued = (session) => session.events.filter((event) => event.processed_at === null);

it('answers a stop only once the reply it cancelled is taken and that turn interrupted too', async (t) => {
  const h = setup(t, { linked: false });
  const session = await h.started();
  h.claude.work(session);
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox'))).status, 200);
  await until(h, () => session.received.length === 2, 'sends the reply');
  assert.equal(queued(session).length, 1, 'the reply waits behind the running turn');
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  for (let i = 0; i < 3; i++) await h.tick();
  assert.deepEqual(typed(h, 'response'), [], 'the interrupt jumped the queue, so the cancelled reply would still run');
  h.claude.work(session);
  assert.deepEqual([queued(session), session.stopping], [[], false], 'the interrupted turn ended and the agent took the cancelled reply');
  await until(h, () => typed(h, 'response').length > 0, 'answers the stop');
  assert.deepEqual(typed(h, 'response'), [[2, 'Stopped.']]);
  assert.equal(session.stopping, true, 'the turn the cancelled reply started is interrupted');

  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Try Chrome instead'))).status, 200);
  await until(h, () => session.received.length === 3, 'sends the next reply to the same session');
  assert.equal(h.claude.sessions.length, 1);
});

it('gives the session up when the cancelled reply is still queued after every retry of the halt', async (t) => {
  const h = setup(t, { linked: false });
  const session = await h.started();
  h.claude.work(session);
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox'))).status, 200);
  await until(h, () => session.received.length === 2, 'sends the reply');
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  await until(h, () => typed(h, 'response').length > 0, 'answers the stop');
  assert.deepEqual(typed(h, 'response'), [[2, 'Stopped.']]);
  assert.ok(session.interrupts > 1, 'the halt was retried, and each attempt interrupted');
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Try Chrome instead'))).status, 200);
  await until(h, () => h.claude.sessions.length === 2 && h.claude.sessions[1].received.length > 0, 'opens a new session for the next reply');
  assert.deepEqual(session.received, [openingText(), 'Also fix Firefox']);
  assert.deepEqual(h.claude.sessions[1].received, [openingText('Try Chrome instead')]);
});

it('answers a stop that follows a create whose answer was lost without a call, since that session was sent nothing', async (t) => {
  const h = setup(t);
  await h.connect();
  h.claude.state.lose = 'open';
  assert.equal((await h.deliver(h.shortcut.open())).status, 200);
  await h.tick();
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  await until(h, () => typed(h, 'response').length > 0, 'answers the stop');
  assert.deepEqual(typed(h, 'response'), [[1, 'Stopped.']]);
  assert.deepEqual([h.claude.sessions.length, h.claude.only().events, h.sent()], [1, [], []]);
});

for (const status of [404, 409, 410]) {
  it(`takes a ${status} to an interrupt as a session that is gone`, async (t) => {
    const h = setup(t);
    h.claude.state.gone = status;
    const session = await h.started();
    h.claude.terminate(session);
    await until(h, () => typed(h, 'error').length > 0, 'reports the termination');
    for (let i = 0; i < 6; i++) await h.tick();
    assert.equal(session.interrupts, 0);
    assert.equal(h.sent().filter((event) => event.type === 'user.interrupt').length, 1);
    assert.deepEqual(h.logs.filter(([level]) => level === 'warn'), []);
  });
}

for (const status of [400, 500]) {
  it(`retries an interrupt answered with ${status}, and gives up with a warning`, async (t) => {
    const h = setup(t);
    h.claude.state.gone = status;
    const session = await h.started();
    h.claude.terminate(session);
    await until(h, () => h.logs.some(([level]) => level === 'warn'), 'gives up');
    assert.ok(h.sent().filter((event) => event.type === 'user.interrupt').length > 1);
    assert.deepEqual(h.logs.filter(([level]) => level === 'warn').map(([, message, detail]) => [message, detail]), [['Claude Bridge gave up terminating a Claude session', { sessionId: SID, target: session.id }]]);
    h.assertCleanLogs();
  });
}
