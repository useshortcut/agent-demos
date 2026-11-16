import assert from 'node:assert/strict';
import { it } from 'node:test';
import { SID, assertAbout, consoleUrl, finished, openingText, setup, typed, until } from './harness.mjs';

it('answers ask_user with a result for that call, and sends no plain message while the call waits', async (t) => {
  const h = setup(t);
  const session = await h.started();
  const call = h.claude.ask(session, 'Which browser? (private-question)');
  await until(h, () => typed(h, 'elicitation').length > 0, 'asks the question');
  assert.deepEqual(typed(h, 'elicitation'), [[1, `Which browser? (private-question)\n\n[Open in Claude Console](${consoleUrl(session)})`]]);
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Safari'))).status, 200);
  await until(h, () => session.received.length === 2, 'passes the answer back');
  assert.deepEqual(h.sent(), [
    { type: 'user.message', content: [{ type: 'text', text: openingText() }] },
    { type: 'user.custom_tool_result', custom_tool_use_id: call.id, content: [{ type: 'text', text: 'Safari' }] },
  ]);
  await finished(h, session, 'Fixed Safari');
  assert.deepEqual(typed(h, 'response').map(([turn]) => turn), [2]);
  h.assertCleanLogs();
});

it('adopts a tool result whose answer was lost instead of sending it again', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.claude.ask(session, 'Which browser?');
  await until(h, () => typed(h, 'elicitation').length > 0, 'asks the question');
  h.claude.state.lose = 'send';
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Safari'))).status, 200);
  for (let i = 0; i < 4; i++) await h.tick();
  assert.equal(h.sent().filter((event) => event.type === 'user.custom_tool_result').length, 1, 'the retried send finds the result in the event list');
  assert.deepEqual(session.received, [openingText(), 'Safari']);
  assert.deepEqual(typed(h, 'error'), []);
  await finished(h, session, 'Fixed Safari');
});

it('opens a new session with the reply, the story link, and the context when the last one was terminated', async (t) => {
  const h = setup(t);
  const session = await h.started();
  await finished(h, session, 'Fixed it');
  h.claude.terminate(session);
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox'))).status, 200);
  await until(h, () => h.claude.sessions.length === 2 && h.claude.sessions[1].received.length > 0, 'opens a new session');
  assert.deepEqual(session.received, [openingText()]);
  assert.deepEqual(h.claude.sessions[1].received, [openingText('Also fix Firefox')]);
  assert.deepEqual(typed(h, 'thought').filter(([turn]) => turn === 2).map(([, body]) => body), ['Passing your message to Claude.', 'The last Claude session ended. Starting a new one.']);
  await finished(h, h.claude.sessions[1], 'Fixed Firefox too');
  assert.deepEqual(typed(h, 'response').map(([turn]) => turn), [1, 2]);
});

it('reads an event list that spans many pages to its end', async (t) => {
  const h = setup(t);
  h.claude.state.pageSize = 2;
  const session = await h.started();
  for (let i = 1; i <= 6; i++) h.claude.say(session, `Step ${i}`);
  await finished(h, session, 'Fixed it');
  assert.deepEqual(typed(h, 'response'), [[1, `Fixed it\n\n[Open in Claude Console](${consoleUrl(session)})`]]);
  assert.ok(h.claudeCalls('GET', /\/events$/).some((r) => new URLSearchParams(r.query).has('page')), 'follows next_page');
});

it('ends the turn with an error, and starts a new session for the reply, when the event list runs past the page cap', async (t) => {
  const h = setup(t, { linked: false });
  h.claude.state.pageSize = 1;
  const session = await h.started();
  for (let i = 1; i <= 8; i++) h.claude.say(session, `Step ${i}`);
  h.claude.finish(session);
  assert.equal(session.events.length, 11);
  await until(h, () => h.shortcut.activities().some((a) => a.content.type !== 'thought'), 'ends the turn');
  assert.deepEqual([typed(h, 'error'), typed(h, 'response')], [[[1, 'The Claude session has more events than Claude Bridge reads. Reply to start a new one.']], []]);
  assert.deepEqual(h.logs.filter(([level]) => level === 'warn'), [['warn', 'Claude Bridge read a cut-short Claude event list', { claudeSessionId: session.id }]]);
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Try again'))).status, 200);
  await until(h, () => h.claude.sessions.length === 2 && h.claude.sessions[1].received.length > 0, 'opens a new session');
  assert.deepEqual(h.claude.sessions[1].received, [openingText('Try again')]);
  h.assertCleanLogs();
});

it('waits out a 429 for its Retry-After and retries a 5xx, logging only the request and status', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.claude.failNext(429, { 'retry-after': '30' }, /^GET \/v1\/sessions\/[^/]+\/events$/);
  await h.tick();
  assertAbout(await h.alarmIn(), 30_000, 'Retry-After');
  h.claude.failNext(503, {}, /^GET \/v1\/sessions\/[^/]+\/events$/);
  await h.tick();
  await finished(h, session, 'Fixed it');
  assert.deepEqual(typed(h, 'error'), []);
  const rejected = h.logs.filter(([, message]) => message === 'Claude request rejected').map(([, , detail]) => detail);
  assert.deepEqual(rejected, [{ request: 'events.list', claudeSessionId: session.id, status: 429 }, { request: 'events.list', claudeSessionId: session.id, status: 503 }]);
  h.assertCleanLogs();
});

const immediate = () => new Promise((resolve) => setImmediate(resolve));

it('ends a request whose response body never ends after 15 seconds, and reads the answer on the retry', async (t) => {
  const h = setup(t, { linked: false });
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const session = await h.started();
  h.claude.say(session, 'Fixed it');
  h.claude.finish(session);
  const lists = () => h.claudeCalls('GET', /\/events$/).length;
  const before = lists();
  h.claude.failNext('stall', {}, /^GET \/v1\/sessions\/[^/]+\/events$/);
  let settled = false;
  const poll = h.tick().then(() => { settled = true; });
  for (let i = 0; i < 100 && lists() === before; i++) await immediate();
  for (let i = 0; i < 20; i++) await immediate();
  t.mock.timers.tick(14_999);
  for (let i = 0; i < 20; i++) await immediate();
  assert.equal(settled, false, 'the request has its full 15 seconds');
  t.mock.timers.tick(1);
  for (let i = 0; i < 100 && !settled; i++) await immediate();
  assert.equal(settled, true, 'the deadline covers the body, not only the headers');
  await poll;
  assert.deepEqual(h.logs.filter(([level]) => level === 'error'), [['error', 'Claude request failed', { request: 'events.list', claudeSessionId: session.id, timeoutMs: 15_000 }]]);
  await until(h, () => typed(h, 'response').length > 0, 'answers on the retry');
  assert.deepEqual(typed(h, 'response'), [[1, 'Fixed it']]);
});

const query = (request) => new URLSearchParams(request.query);

it('lists events with the types, order, and limit each read needs', async (t) => {
  const h = setup(t, { linked: false });
  const session = await h.started();
  h.claude.ask(session, 'Which browser?');
  await until(h, () => typed(h, 'elicitation').length > 0, 'asks');
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Safari'))).status, 200);
  await until(h, () => session.received.length === 2, 'answers');
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  await until(h, () => typed(h, 'response').length > 0, 'answers the stop');
  const lists = h.claudeCalls('GET', /\/events$/).map((r) => JSON.stringify([query(r).getAll('types[]'), query(r).get('order'), query(r).get('limit')]));
  assert.equal(lists.filter((shape) => shape === lists[0]).length, 1, 'only a session with no confirmed send is asked whether it holds a message');
  assert.deepEqual([...new Set(lists)].map((shape) => JSON.parse(shape)), [
    [['user.message'], 'desc', '1'],
    [['session.status_running', 'session.status_idle', 'agent.custom_tool_use'], 'desc', '20'],
    [['user.message', 'user.custom_tool_result', 'agent.message', 'agent.custom_tool_use', 'session.status_running', 'session.status_idle', 'session.status_terminated'], 'asc', '1000'],
    [['user.custom_tool_result'], 'desc', '20'],
    [['user.message', 'user.custom_tool_result'], 'desc', '20'],
  ]);
});

it('lists the next turn from the idle that ended the last one, and keeps the start while a question waits', async (t) => {
  const h = setup(t, { linked: false });
  const session = await h.started();
  const turns = () => h.claudeCalls('GET', /\/events$/).map(query).filter((q) => q.get('order') === 'asc');
  h.claude.ask(session, 'Which browser?');
  await until(h, () => typed(h, 'elicitation').length > 0, 'asks');
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Safari'))).status, 200);
  await until(h, () => session.received.length === 2, 'answers');
  await finished(h, session, 'Fixed Safari');
  assert.deepEqual(turns().map((q) => q.get('created_at[gte]')), turns().map(() => null), 'an idle that waits on a call does not move the start');
  const idle = session.events.findLast((event) => event.type === 'session.status_idle');
  const before = turns().length;
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox'))).status, 200);
  await until(h, () => session.received.length === 3, 'sends the reply');
  await finished(h, session, 'Fixed Firefox too');
  assert.deepEqual([...new Set(turns().slice(before).map((q) => q.get('created_at[gte]')))], [idle.processed_at]);
});

it('reads a turn that fills exactly the last page it reads', async (t) => {
  const h = setup(t, { linked: false });
  h.claude.state.pageSize = 1;
  const session = await h.started();
  for (let i = 1; i <= 7; i++) h.claude.say(session, `Step ${i}`);
  h.claude.finish(session);
  assert.equal(session.events.length, 10);
  await until(h, () => h.shortcut.activities().some((a) => a.content.type !== 'thought'), 'ends the turn');
  assert.deepEqual([typed(h, 'response'), typed(h, 'error')], [[[1, 'Step 7']], []]);
});

it('sends a message again when the answer to the send names no event', async (t) => {
  for (const body of [{ data: [] }, { data: [{ id: '' }] }, {}]) {
    const h = setup(t, { linked: false });
    const session = await h.started();
    await finished(h, session, 'Fixed it');
    h.claude.state.answer = { call: 'send', body };
    assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox'))).status, 200);
    await until(h, () => session.received.length === 3, 'sends again');
    assert.deepEqual(session.received.slice(1), ['Also fix Firefox', 'Also fix Firefox']);
    await finished(h, session, 'Fixed Firefox too');
    assert.deepEqual(typed(h, 'error'), []);
  }
});

it('logs a request that fails in the network as the request and the session, and retries it', async (t) => {
  const h = setup(t, { linked: false });
  const session = await h.started();
  h.claude.failNext('network', {}, /^GET \/v1\/sessions\/[^/]+\/events$/);
  await finished(h, session, 'Fixed it');
  assert.deepEqual(h.logs.filter(([level]) => level !== 'log'), [['error', 'Claude request failed', { request: 'events.list', claudeSessionId: session.id, timeoutMs: 15_000 }]]);
  h.assertCleanLogs();
});
