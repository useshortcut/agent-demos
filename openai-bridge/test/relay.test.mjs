import assert from 'node:assert/strict';
import { it } from 'node:test';
import { SID, openingText, setup } from './harness.mjs';

async function finished(h, session, text) {
  h.openai.work(session);
  h.openai.say(session, text, 'final_answer');
  h.openai.finish(session);
  await h.tick();
  assert.ok(h.shortcut.activities().some((a) => a.content.type === 'response' && a.content.body === text), `the bridge posts "${text}"`);
}

const events = (h) => h.openaiCalls('POST', /\/events$/).map((r) => ({ key: r.key, event: JSON.parse(r.body).events[0] }));

it('sends a reply as a message under one key per send: the same key when the send is retried, a new one for the next reply', async (t) => {
  const h = setup(t);
  const session = await h.started();
  await finished(h, session, 'Fixed it');

  h.openai.failNext(503, {}, /POST .*\/events$/);
  await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox (private-prompt)'));
  await h.tick();
  await h.tick();
  await finished(h, session, 'Fixed Firefox too');
  await h.deliver(h.shortcut.prompt(SID, 'And Edge (private-prompt)'));
  await h.tick();

  const sent = events(h);
  assert.deepEqual(sent.map(({ event }) => event), [
    ...[1, 2].map(() => ({ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Also fix Firefox (private-prompt)' }] }] })),
    { type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'And Edge (private-prompt)' }] }] },
  ]);
  const [first, retry, next] = sent.map(({ key }) => key);
  assert.match(first, /^shortcut-session-sess-1-1:\d+$/);
  assert.equal(retry, first, 'a retried send repeats its key');
  assert.notEqual(next, first, 'the next reply has a key of its own');
  assert.deepEqual(session.received, ['Also fix Firefox (private-prompt)', 'And Edge (private-prompt)']);
  h.assertCleanLogs();
});

async function asked(h, question) {
  const session = await h.started();
  const call = h.openai.ask(session, question);
  await h.tick();
  return { session, call };
}

it('answers ask_user with the reply as the call\'s result, and sends nothing again once the agent took the result', async (t) => {
  const h = setup(t);
  const { session, call } = await asked(h, 'Which browser?');
  assert.deepEqual(h.shortcut.activities().filter((a) => a.content.type === 'elicitation').map((a) => [a.key, a.content.body]), [[`openai-bridge:1:elicitation:${call.call_id}`, 'Which browser?']]);

  h.openai.state.loseSend = true;
  await h.deliver(h.shortcut.prompt(SID, 'Safari'));
  await h.tick();
  h.openai.work(session);
  await h.tick();
  assert.deepEqual(events(h).map(({ event }) => event), [{ type: 'agent.session.input.tool_result', turn_id: call.turn_id, call_id: call.call_id, success: true, output: 'Safari' }],
    'the retried send finds the call no longer pending and sends nothing');
  assert.deepEqual(session.received, ['Safari']);
  await finished(h, session, 'Fixed Safari');
  assert.deepEqual(h.shortcut.activities().filter((a) => a.content.type === 'response').map((a) => [a.turn, a.content.body]), [[2, 'Fixed Safari']]);
  assert.equal(h.openai.sessions.length, 1);
});

it('repeats a result under the same key when the answer to the first attempt is lost and the call is still pending', async (t) => {
  const h = setup(t);
  const { session, call } = await asked(h, 'Which browser?');
  h.openai.state.loseSend = true;
  await h.deliver(h.shortcut.prompt(SID, 'Safari'));
  await h.tick();
  await h.tick();
  const sent = events(h);
  assert.deepEqual(sent.map(({ event }) => [event.type, event.call_id, event.output]), [1, 2].map(() => ['agent.session.input.tool_result', call.call_id, 'Safari']));
  assert.match(sent[0].key, /^shortcut-session-sess-1-1:\d+$/);
  assert.equal(sent[1].key, sent[0].key, 'the repeat carries the key of the first attempt, as the SDK\'s own dispatcher does');
  assert.deepEqual(session.received, ['Safari', 'Safari'], 'a service that does not drop the repeat sees the result twice');
});

it('reads a question whose arguments arrive as a JSON string', async (t) => {
  const h = setup(t);
  const session = await h.started();
  const call = h.openai.ask(session, 'unused');
  call.arguments = JSON.stringify({ question: 'Which browser?' });
  await h.tick();
  assert.deepEqual(h.shortcut.activities().filter((a) => a.content.type === 'elicitation').map((a) => a.content.body), ['Which browser?']);
});

for (const [condition, end] of [['failed', (s) => { s.status = 'failed'; }], ['was deleted', (s) => { s.deleted = true; }]]) {
  it(`opens a new session with the reply when the one it was meant for ${condition}`, async (t) => {
    const h = setup(t);
    const session = await h.started();
    await finished(h, session, 'Fixed it');
    end(session);
    await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox'));
    for (let i = 0; i < 3; i++) await h.tick();

    assert.equal(h.openai.sessions.length, 2);
    assert.deepEqual(session.received, []);
    assert.equal(h.openai.sessions[1].opened, openingText('Also fix Firefox'), 'the new session is told the reply, the story link, and the context');
    assert.ok(h.shortcut.activities().some((a) => a.key === 'openai-bridge:2:restart'));
  });
}
