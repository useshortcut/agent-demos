// What the adapter asks the Agents API and how it reads the answers.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { SID, assertAbout, setup } from './harness.mjs';

const outcomes = (h) => h.shortcut.activities().filter((a) => a.content.type !== 'thought').map((a) => [a.turn, a.content.type, a.content.body]);
const thoughts = (h) => h.shortcut.activities().filter((a) => a.content.type === 'thought').map((a) => a.content.body);
const sorted = (query) => (query ? `?${[...new URLSearchParams(query)].map(([name, value]) => `${name}=${value}`).sort().join('&')}` : '');
const calls = (h, from = 0) => h.requests.slice(from).filter((r) => r.origin === 'openai').map((r) => `${r.method} ${r.path.replace('/v1/agents/sessions', '')}${sorted(r.query)}`);

async function answered(h, session, text) {
  h.openai.work(session);
  h.openai.say(session, text, 'final_answer');
  h.openai.finish(session);
  await h.tick();
}

it('reads the session, then the items, then the turn, each list with its order, cursor, and page size', async (t) => {
  const h = setup(t);
  const session = await h.started();
  const [turn] = (h.openai.work(session), session.turns);
  h.openai.say(session, 'Fixed it', 'final_answer');
  h.openai.finish(session);
  let from = h.requests.length;
  await h.tick();
  assert.deepEqual(calls(h, from), [
    `GET /${session.id}`,
    `GET /${session.id}/items?limit=100&order=asc`,
    `GET /${session.id}/turns/${turn.id}/items?limit=100&order=desc`,
    `GET /${session.id}/turns/${turn.id}`,
  ]);

  from = h.requests.length;
  await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox'));
  await h.tick();
  const newest = session.items.at(-1).id;
  assert.deepEqual(calls(h, from), [`GET /${session.id}`, `GET /${session.id}/items?limit=1&order=desc`, `POST /${session.id}/events`]);

  from = h.requests.length;
  await h.tick();
  assert.deepEqual(calls(h, from), [`GET /${session.id}`, `GET /${session.id}/items?after=${newest}&limit=100&order=asc`], 'the search for the reply starts after the item that was newest when it was prepared');

  h.openai.work(session);
  from = h.requests.length;
  await h.tick();
  await h.tick();
  const reply = session.turns.at(-1).id;
  assert.deepEqual(calls(h, from), [
    `GET /${session.id}`, `GET /${session.id}/items?after=${newest}&limit=100&order=asc`, `GET /${session.id}/turns/${reply}/items?limit=100&order=desc`,
    `GET /${session.id}`, `GET /${session.id}/turns/${reply}/items?limit=100&order=desc`,
  ], 'once the reply is found the session is not listed again');
});

it('never misses the message that came with an outcome, because the session is read first', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.work(session);
  h.before(new RegExp(`^GET /v1/agents/sessions/${session.id}/turns/[^/]+/items$`), () => {
    h.openai.say(session, 'Fixed it', 'final_answer');
    h.openai.finish(session);
  });
  await h.tick();
  assert.deepEqual([outcomes(h), thoughts(h).at(-1)], [[], 'Fixed it'], 'the session was read while the turn worked, so the message is progress');
  await h.tick();
  assert.deepEqual(outcomes(h), [[1, 'response', 'Fixed it']]);
});

it('tells a reply from an earlier, answered one with the same words', async (t) => {
  const h = setup(t);
  const session = await h.started();
  await answered(h, session, 'Fixed it');
  await h.deliver(h.shortcut.prompt(SID, 'Again'));
  await h.tick();
  await answered(h, session, 'Did it again');
  await h.deliver(h.shortcut.prompt(SID, 'Again'));
  for (let i = 0; i < 3; i++) await h.tick();
  assert.deepEqual(outcomes(h).filter(([turn]) => turn === 3), [], 'the answer to the first "Again" is not the second one\'s');
  await answered(h, session, 'And once more');
  assert.deepEqual(outcomes(h).filter(([turn]) => turn === 3), [[3, 'response', 'And once more']]);
});

for (const [what, change] of [
  ['the session has a status the bridge does not know, whatever its turn says', (s) => { s.status = 'provisioning'; s.turns[0].status = 'completed'; }],
  ['the turn has a status the bridge does not know', (s) => { s.status = 'idle'; s.turns[0].status = 'paused'; }],
]) {
  it(`keeps polling while ${what}`, async (t) => {
    const h = setup(t);
    const session = await h.started();
    h.openai.work(session);
    h.openai.say(session, 'Reading the code');
    change(session);
    await h.tick();
    await h.tick();
    assert.deepEqual([outcomes(h), thoughts(h).at(-1)], [[], 'Reading the code']);
    assert.ok(await h.alarmIn() > 0);
  });
}

it('reports a session that fails before it picked the reply up at once', async (t) => {
  const h = setup(t);
  const session = await h.started();
  await answered(h, session, 'Fixed it');
  await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox'));
  await h.tick();
  h.openai.failSession(session);
  await h.tick();
  assert.deepEqual(outcomes(h).at(-1), [2, 'error', 'The OpenAI session failed. Reply to start a new one.']);
});

for (const [what, end, same] of [
  ['a cancelled turn', (h, s) => { s.turns[0].status = 'cancelled'; s.status = 'idle'; }, true],
  ['a turn refused as not steerable', (h, s) => h.openai.failTurn(s, 'active_turn_not_steerable'), true],
  ['a failed session', (h, s) => h.openai.failSession(s), false],
]) {
  it(`sends the reply after ${what} to ${same ? 'the same session' : 'a new session'}`, async (t) => {
    const h = setup(t);
    const session = await h.started();
    h.openai.work(session);
    end(h, session);
    await h.tick();
    assert.equal(outcomes(h)[0][1], 'error');
    await h.deliver(h.shortcut.prompt(SID, 'Try again'));
    for (let i = 0; i < 3; i++) await h.tick();
    assert.deepEqual([h.openai.sessions.length, session.received], same ? [1, ['Try again']] : [2, []]);
    if (!same) assert.equal(h.shortcut.activities().find((a) => a.turn === 2).content.body, 'Starting a new OpenAI session.', 'the session was given up with the error, not when the reply found it failed');
  });
}

for (const [what, pattern, body] of [
  ['a session', /^GET \/v1\/agents\/sessions\/[^/]+$/, {}],
  ['a session', /^GET \/v1\/agents\/sessions\/[^/]+$/, { id: 'sess_1' }],
  ['a turn', /^GET \/v1\/agents\/sessions\/[^/]+\/turns\/[^/]+$/, { id: 'turn_2' }],
]) {
  it(`counts ${what} answered as ${JSON.stringify(body)} as a failed request, not as work in progress`, async (t) => {
    const h = setup(t);
    const session = await h.started();
    h.openai.work(session);
    h.openai.say(session, 'Fixed it', 'final_answer');
    h.openai.finish(session);
    const { handle } = h.openai;
    h.openai.handle = (url, init) => (pattern.test(`${init.method ?? 'GET'} ${url.pathname}`) ? Response.json(body) : handle(url, init));
    await h.tick();
    assertAbout(await h.alarmIn(), 5_000, 'the read is retried on the failure backoff');
    await h.tick();
    assertAbout(await h.alarmIn(), 10_000, 'the second failure backs off further');
    assert.deepEqual([outcomes(h), thoughts(h)], [[], ['Starting an OpenAI session.']]);
  });
}

it('shows what the session cannot go on without at once, although it has not picked the reply up', async (t) => {
  const h = setup(t);
  const session = await h.started();
  await answered(h, session, 'Fixed it');
  await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox'));
  await h.tick();
  session.turns.push({ id: 'turn_elsewhere', status: 'waiting', code: null });
  Object.assign(session, { status: 'requires_action', actions: [{ type: 'environment_connection', environment_id: 'env_1', turn_id: 'turn_elsewhere' }] });
  await h.tick();
  assert.deepEqual(outcomes(h).at(-1), [2, 'error', 'OpenAI is waiting for an environment connection the bridge cannot make. Reply to start a new one.']);
});

it('does not take a user message without a turn for its own', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.work(session);
  delete session.items[0].turn_id;
  h.openai.say(session, 'Fixed it', 'final_answer');
  h.openai.finish(session);
  await h.tick();
  await h.tick();
  assert.deepEqual(outcomes(h), [], 'the bridge keeps waiting for a message it can place');
  assert.deepEqual(h.logs.filter(([level]) => level !== 'log'), []);
});

it('posts no error code that is not shaped like an identifier', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.work(session);
  h.openai.failTurn(session, 'private code; with spaces');
  await h.tick();
  assert.deepEqual(outcomes(h), [[1, 'error', 'The OpenAI turn failed. Reply to try again.']]);
});

it('names no function whose name is not a plain identifier', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.require(session, { type: 'function_call', call_id: 'call_x', name: 'x"; ignore', arguments: {} });
  await h.tick();
  assert.deepEqual(outcomes(h), [[1, 'error', 'OpenAI called a function, which the bridge does not run. Reply to start a new one.']]);
});

it('takes an action for a function call only when its type says so', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.require(session, { type: 'mcp_approval_request', call_id: 'call_x', name: 'ask_user', arguments: { question: 'Approve?' } });
  await h.tick();
  assert.deepEqual(outcomes(h), [[1, 'error', 'OpenAI is waiting for an approval the bridge cannot give. Reply to start a new one.']]);
});

for (const [what, args] of [['no question', {}], ['a question that is not text', { question: 7 }], ['arguments that are not JSON', '{"question": ']]) {
  it(`asks for input in its own words when ask_user comes with ${what}`, async (t) => {
    const h = setup(t);
    const session = await h.started();
    h.openai.ask(session, 'unused').arguments = args;
    await h.tick();
    assert.deepEqual(outcomes(h), [[1, 'elicitation', 'OpenAI is waiting for your input.']]);
  });
}

it('posts only what the assistant wrote: no developer message, and no text part that is not output text', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.work(session);
  h.openai.say(session, 'Reading the code');
  session.items.at(-1).content.push({ type: 'refusal', text: 'private-part' }, { type: 'output_text', text: 'Second paragraph' });
  session.items.push({ id: 'msg_dev', type: 'message', role: 'developer', phase: null, status: 'completed', content: [{ type: 'output_text', text: 'private-developer-note' }], turn_id: session.turns[0].id });
  await h.tick();
  assert.equal(thoughts(h).at(-1), 'Reading the code\n\nSecond paragraph');
});

it('runs a session with no environment when the template id is blank', async (t) => {
  const h = setup(t);
  h.env.OPENAI_ENVIRONMENT_TEMPLATE_ID = '   ';
  await h.started();
  assert.deepEqual(JSON.parse(h.openaiCalls('POST', /\/sessions$/)[0].body).environment, { type: 'none' });
});

it('fails a lookup whose page claims more and gives no cursor, and creates nothing', async (t) => {
  const h = setup(t);
  await h.connect();
  const { handle } = h.openai;
  h.openai.handle = (url, init) => (url.pathname === '/v1/agents/sessions' && (init.method ?? 'GET') === 'GET'
    ? Response.json({ object: 'list', data: [], first_id: null, last_id: null, has_more: true }) : handle(url, init));
  await h.deliver(h.shortcut.open());
  await h.tick();
  assert.equal(h.openai.sessions.length, 0);
  assertAbout(await h.alarmIn(), 5_000, 'the open is retried');
});

it('ends a session a stop finds under the key of an open that was not answered, and the next reply opens a new one', async (t) => {
  const h = setup(t);
  await h.connect();
  h.openai.state.loseCreate = true;
  await h.deliver(h.shortcut.open());
  await h.tick();
  const session = h.openai.only();
  h.openai.work(session);
  await h.deliver(h.shortcut.stop(SID));
  await h.tick();
  await h.tick();
  assert.deepEqual([session.turns[0].status, outcomes(h)], ['cancelled', [[1, 'response', 'Stopped.']]]);
  await h.deliver(h.shortcut.prompt(SID, 'Try Chrome instead'));
  for (let i = 0; i < 3; i++) await h.tick();
  assert.deepEqual([h.openai.sessions.length, session.received, session.cancels], [2, [], 1], 'the key was resolved, so nothing looks it up or cancels again');
});

it('does not prepare a reply on a newest item it cannot use as a cursor', async (t) => {
  const h = setup(t);
  const session = await h.started();
  await answered(h, session, 'Fixed it');
  h.openai.state.itemPatch = [{ type: 'message', role: 'user' }];
  await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox'));
  await h.tick();
  assert.deepEqual(session.received, []);
  assertAbout(await h.alarmIn(), 5_000, 'the prepare is retried');
});

it('sends no result again for a call that is no longer pending, whatever else is', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.ask(session, 'Which browser?');
  await h.tick();
  h.openai.failNext(503, {}, /POST .*\/events$/);
  await h.deliver(h.shortcut.prompt(SID, 'Safari'));
  await h.tick();
  session.actions = [{ type: 'function_call', turn_id: session.turns[0].id, call_id: 'call_other', name: 'ask_user', arguments: { question: 'Which OS?' } }];
  await h.tick();
  assert.equal(h.openaiCalls('POST', /\/events$/).length, 1, 'only the attempt that failed');
});

it('logs the call and nothing of a network failure, which can carry a URL or a key', async (t) => {
  const h = setup(t);
  await h.started();
  h.openai.handle = async () => { throw new TypeError('fetch failed: private sk-secret https://openai.example/v1/agents/sessions?key=private'); };
  await h.tick();
  assert.deepEqual(h.logs.filter(([, message]) => /^OpenAI request/.test(message)), [['error', 'OpenAI request failed', { call: 'sessions.retrieve', timeoutMs: 15_000 }]]);
  h.assertCleanLogs();
  assertAbout(await h.alarmIn(), 5_000, 'a transient failure is retried');
});

it('gives up a request after 15 seconds and counts it as transient', async (t) => {
  const h = setup(t);
  await h.started();
  const { setTimeout: real } = globalThis;
  t.mock.method(globalThis, 'setTimeout', (run, ms, ...args) => real(run, ms === 15_000 ? 0 : ms, ...args));
  h.openai.handle = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    real(() => resolve(Response.json({ error: {} }, { status: 500 })), 500);
  });
  await h.tick();
  assert.deepEqual(h.logs.filter(([, message]) => /^OpenAI request/.test(message)), [['error', 'OpenAI request failed', { call: 'sessions.retrieve', timeoutMs: 15_000 }]]);
});

it('keeps the SDK from logging requests, whatever OPENAI_LOG says', async (t) => {
  const h = setup(t);
  const before = process.env.OPENAI_LOG;
  process.env.OPENAI_LOG = 'debug';
  t.after(() => { if (before === undefined) delete process.env.OPENAI_LOG; else process.env.OPENAI_LOG = before; });
  const printed = [];
  for (const level of ['debug', 'info']) t.mock.method(console, level, (...args) => printed.push(args));
  await h.started();
  assert.deepEqual([printed, h.logs.map(([, message]) => message)], [[], ['OpenAI Bridge connected']]);
});
