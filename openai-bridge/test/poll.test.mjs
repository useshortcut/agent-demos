import assert from 'node:assert/strict';
import { it } from 'node:test';
import { SID, assertAbout, setup } from './harness.mjs';

const ofType = (h, type) => h.shortcut.activities().filter((a) => a.content.type === type);
const outcomes = (h) => h.shortcut.activities().filter((a) => a.content.type !== 'thought').map((a) => [a.turn, a.content.type, a.content.body]);

async function finished(h, session, text) {
  h.openai.work(session);
  h.openai.say(session, text, 'final_answer');
  h.openai.finish(session);
  await h.tick();
}

it('posts commentary as progress and the last message as the response, skipping a message still being written', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.work(session);
  h.openai.say(session, 'Reading the code');
  h.openai.say(session, 'Half a sentence');
  session.items.at(-1).status = 'in_progress';
  await h.tick();
  assert.deepEqual(ofType(h, 'thought').map((a) => a.content.body).at(-1), 'Reading the code');
  session.items.at(-1).status = 'completed';
  await h.tick();
  assert.deepEqual(ofType(h, 'thought').map((a) => a.content.body).at(-1), 'Half a sentence', 'each message is new progress');
  h.openai.say(session, 'Fixed it', 'final_answer');
  h.openai.finish(session);
  await h.tick();
  assert.deepEqual(outcomes(h), [[1, 'response', 'Fixed it']]);
  h.assertCleanLogs();
});

it('treats an idle session whose turn has not completed as working, not finished', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.work(session);
  h.openai.say(session, 'Queued up');
  Object.assign(session, { status: 'idle' });
  session.turns[0].status = 'queued';
  for (let i = 0; i < 3; i++) await h.tick();
  assert.deepEqual(outcomes(h), []);
  h.openai.finish(session);
  await h.tick();
  assert.deepEqual(outcomes(h), [[1, 'response', 'Queued up']]);
});

it('waits while a reply is not picked up, and after 10 minutes ends the turn and keeps the session', async (t) => {
  const h = setup(t);
  const session = await h.started();
  await finished(h, session, 'Fixed it');
  await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox'));
  await h.tick();
  assert.deepEqual(session.received, ['Also fix Firefox']);
  const started = Date.now();
  while (ofType(h, 'error').length === 0 && Date.now() - started < 700_000) await h.tick();
  assert.deepEqual(outcomes(h).filter(([turn]) => turn === 2), [[2, 'error', 'OpenAI did not pick up your reply. Reply to try again.']]);
  assert.ok(Date.now() - started >= 600_000, 'the bridge waited out the pickup timeout');

  await h.deliver(h.shortcut.prompt(SID, 'Still there?'));
  await h.tick();
  assert.equal(h.openai.sessions.length, 1);
  assert.deepEqual(session.received, ['Also fix Firefox', 'Still there?']);
});

for (const [code, body] of [
  ['server_overloaded', 'The OpenAI turn failed (server_overloaded). Reply to try again.'],
  [null, 'The OpenAI turn failed. Reply to try again.'],
]) {
  it(`ends the turn with an error when the turn fails with ${code ?? 'no code'}, and the next reply goes to the same session`, async (t) => {
    const h = setup(t);
    const session = await h.started();
    h.openai.work(session);
    h.openai.failTurn(session, code);
    await h.tick();
    assert.deepEqual(outcomes(h), [[1, 'error', body]]);
    assert.equal(session.cancels, 0, 'the session is kept');
    await h.deliver(h.shortcut.prompt(SID, 'Try again'));
    await h.tick();
    assert.deepEqual(session.received, ['Try again']);
    h.assertCleanLogs();
  });
}

it('says the reply could not be taken when OpenAI refuses it with active_turn_not_steerable, once the working turn is over', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.work(session);
  await h.tick();
  await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox'));
  await h.tick();
  assert.deepEqual(session.received, ['Also fix Firefox'], 'the reply goes to the working session');
  h.openai.state.unsteerable = true;
  h.openai.work(session);
  await h.tick();
  assert.deepEqual(outcomes(h), [], 'the working turn goes on');
  h.openai.say(session, 'Fixed the login', 'final_answer');
  h.openai.finish(session);
  await h.tick();
  assert.deepEqual(outcomes(h), [[2, 'error', 'OpenAI could not take your reply while it was working. Reply to try again.']]);
});

it('ends the turn with an error when the turn is cancelled in OpenAI', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.work(session);
  session.turns[0].status = 'cancelled';
  session.status = 'idle';
  await h.tick();
  assert.deepEqual(outcomes(h), [[1, 'error', 'The OpenAI turn was cancelled. Reply to try again.']]);
});

for (const [what, action, body] of [
  ['an approval', { type: 'mcp_approval_request', request_id: 'req_1', request: { type: 'mcp_tool_call', message: 'private-approval', name: 'deploy', server_label: 'ops', arguments: {} } },
    'OpenAI is waiting for an approval the bridge cannot give. Reply to start a new one.'],
  ['an environment connection', { type: 'environment_connection', environment_id: 'env_1' }, 'OpenAI is waiting for an environment connection the bridge cannot make. Reply to start a new one.'],
  ['a function it does not run', { type: 'function_call', call_id: 'call_x', name: 'lookup_customer', arguments: {} }, 'OpenAI called the function lookup_customer, which the bridge does not run. Reply to start a new one.'],
]) {
  it(`gives the session up when it waits on ${what}, and the next reply opens a new one`, async (t) => {
    const h = setup(t);
    const session = await h.started();
    h.openai.require(session, action);
    await h.tick();
    await h.tick();
    assert.deepEqual(outcomes(h), [[1, 'error', body]]);
    assert.equal(session.cancels, 1, 'giving it up cancels the waiting turn');
    await h.deliver(h.shortcut.prompt(SID, 'Try again'));
    await h.tick();
    assert.equal(h.openai.sessions.length, 2);
    assert.match(h.openai.sessions[1].opened, /Try again/);
    h.assertCleanLogs();
  });
}

it('ends the turn with an error and gives the session up when the session fails', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.work(session);
  h.openai.failSession(session);
  await h.tick();
  assert.deepEqual(outcomes(h), [[1, 'error', 'The OpenAI session failed. Reply to start a new one.']]);
  h.assertCleanLogs();
});

const turnItemCalls = (h) => h.openaiCalls('GET', /\/turns\/[^/]+\/items$/);
const filler = (session, count) => {
  for (let i = 0; i < count; i++) session.items.push({ id: `rs_${session.items.length}`, type: 'reasoning', status: 'completed', summary: [], turn_id: session.turns[0].id });
};

it('finds the last message of a turn of more than 1,000 items by reading the turn newest first', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.work(session);
  filler(session, 1001);
  h.openai.say(session, 'The real answer', 'final_answer');
  h.openai.finish(session);
  await h.tick();
  assert.deepEqual(outcomes(h), [[1, 'response', 'The real answer']]);
  assert.deepEqual(turnItemCalls(h).map((r) => [r.path, Object.fromEntries(new URLSearchParams(r.query))]),
    [[`/v1/agents/sessions/${session.id}/turns/${session.turns[0].id}/items`, { order: 'desc', limit: '100' }]]);
});

it('reads on past the first page for a message that more than 100 newer items follow', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.work(session);
  h.openai.say(session, 'Reading the code');
  filler(session, 150);
  await h.tick();
  assert.deepEqual(ofType(h, 'thought').map((a) => a.content.body).at(-1), 'Reading the code');
  assert.deepEqual(turnItemCalls(h).map((r) => Object.fromEntries(new URLSearchParams(r.query))),
    [{ order: 'desc', limit: '100' }, { order: 'desc', limit: '100', after: session.items.at(-100).id }]);
});

it('reads the newest 1,000 items of a turn for its last message, and no further', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.work(session);
  h.openai.say(session, 'Reading the code');
  filler(session, 1000);
  h.openai.finish(session);
  await h.tick();
  assert.equal(turnItemCalls(h).length, 10);
  assert.deepEqual(outcomes(h), [[1, 'response', 'OpenAI finished.']]);
});

it('takes no message the agent wrote before the reply joined its turn for the reply\'s', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.work(session);
  h.openai.say(session, 'Reading the code');
  await h.tick();
  await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox'));
  await h.tick();
  h.openai.say(session, 'Half way there');
  h.openai.work(session);
  await h.tick();
  assert.deepEqual(h.shortcut.activities().filter((a) => a.turn === 2).map((a) => a.content.body), ['Passing your message to OpenAI.']);
  h.openai.say(session, 'Now also Firefox');
  await h.tick();
  h.openai.say(session, 'Fixed both', 'final_answer');
  h.openai.finish(session);
  await h.tick();
  assert.deepEqual(h.shortcut.activities().filter((a) => a.turn === 2).map((a) => a.content.body), ['Passing your message to OpenAI.', 'Now also Firefox', 'Fixed both']);
});

it('takes no message the agent wrote before its question for what it says after the answer', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.work(session);
  h.openai.say(session, 'Let me check with you');
  h.openai.ask(session, 'Which browser?');
  await h.tick();
  await h.deliver(h.shortcut.prompt(SID, 'Safari'));
  await h.tick();
  h.openai.work(session);
  await h.tick();
  h.openai.finish(session);
  await h.tick();
  assert.deepEqual(h.shortcut.activities().filter((a) => a.turn === 2).map((a) => a.content.body), ['Passing your message to OpenAI.', 'OpenAI finished.']);
});

for (const [what, unreadable] of [
  ['an item of no known shape', { bogus: true }],
  ['a message without an id', { id: null, type: 'message', role: 'assistant', phase: 'commentary', status: 'completed', content: [{ type: 'output_text', text: 'private-newer-message' }] }],
  ['a message without content', { id: 'msg_x', type: 'message', role: 'assistant', phase: 'commentary', status: 'completed' }],
  ['a function call without a call id', { id: 'fc_x', type: 'function_call', name: 'ask_user', arguments: {} }],
]) {
  it(`posts no message while ${what} may hide a newer one, and still reads the outcome`, async (t) => {
    const h = setup(t);
    const session = await h.started();
    h.openai.work(session);
    h.openai.say(session, 'Reading the code');
    h.openai.state.itemPatch = [unreadable];
    await h.tick();
    assert.deepEqual(ofType(h, 'thought').map((a) => a.content.body), ['Starting an OpenAI session.']);
    h.openai.finish(session);
    await h.tick();
    assert.deepEqual(outcomes(h), [[1, 'response', 'OpenAI finished.']]);
    h.assertCleanLogs();
  });
}

it('posts what the agent said after the answer, although another call follows it', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.ask(session, 'Which browser?');
  await h.tick();
  await h.deliver(h.shortcut.prompt(SID, 'Safari'));
  await h.tick();
  h.openai.work(session);
  h.openai.say(session, 'Thanks, on it');
  session.items.push({ id: 'fc_elsewhere', type: 'function_call', status: 'completed', call_id: 'call_elsewhere', name: 'ask_user', arguments: {}, turn_id: session.turns[0].id });
  await h.tick();
  assert.equal(ofType(h, 'thought').map((a) => a.content.body).at(-1), 'Thanks, on it');
});

it('waits for Retry-After on a 429 without spending a strike, and logs no response body', async (t) => {
  const h = setup(t);
  await h.started();
  h.openai.failNext(429, { 'Retry-After': '30' }, /GET \/v1\/agents\/sessions\/[^/]+$/);
  await h.tick();
  assertAbout(await h.alarmIn(), 30_000, 'the Retry-After wait');
  assert.ok(h.logs.some(([level, message, detail]) => level === 'error' && message === 'OpenAI request rejected' && detail.status === 429 && detail.call === 'sessions.retrieve'));
  h.assertCleanLogs();
});

it('keeps the session when OpenAI rejects the key, so the next reply can reach it', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.failNext(401, {}, /GET/);
  await h.tick();
  assert.deepEqual(outcomes(h), [[1, 'error', 'OpenAI rejected the request (HTTP 401). Reply to try again.']]);
  assert.equal(session.cancels, 0);
});
