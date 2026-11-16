// `required_actions` can hold several calls in no promised order, and a call
// stays listed until the agent picks its result up.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { SID, setup } from './harness.mjs';

const questions = (h) => h.shortcut.activities().filter((a) => a.content.type === 'elicitation').map((a) => [a.turn, a.content.body]);
const sent = (h) => h.openaiCalls('POST', /\/events$/).map((r) => JSON.parse(r.body).events[0]).map((e) => (e.type === 'agent.session.input.tool_result' ? ['result', e.call_id, e.output] : ['message', e.input[0].content[0].text]));

async function reply(h, text) {
  await h.deliver(h.shortcut.prompt(SID, text));
  await h.tick();
}

async function askedTwice(h) {
  const session = await h.started();
  const first = h.openai.ask(session, 'Which browser?');
  const second = h.openai.ask(session, 'Which OS?');
  await h.tick();
  assert.deepEqual(questions(h), [[1, 'Which browser?']]);
  return { session, first, second };
}

it('shows two pending questions one at a time, and answers each with the reply to it', async (t) => {
  const h = setup(t);
  const { session, first, second } = await askedTwice(h);
  await reply(h, 'Safari');
  await h.tick();
  assert.deepEqual(questions(h), [[1, 'Which browser?'], [2, 'Which OS?']], 'the first call is answered and still listed, and the second is shown');
  await reply(h, 'macOS');
  assert.deepEqual(sent(h), [['result', first.call_id, 'Safari'], ['result', second.call_id, 'macOS']]);
  h.openai.work(session);
  h.openai.say(session, 'Fixed it', 'final_answer');
  h.openai.finish(session);
  await h.tick();
  assert.deepEqual(h.shortcut.activities().filter((a) => a.content.type === 'response').map((a) => [a.turn, a.content.body]), [[3, 'Fixed it']]);
  assert.deepEqual(questions(h).length, 2, 'no question is asked twice');
});

it('answers the call whose question was shown when the list of calls changes its order', async (t) => {
  const h = setup(t);
  const { session, first } = await askedTwice(h);
  session.actions.reverse();
  await reply(h, 'Safari');
  assert.deepEqual(sent(h), [['result', first.call_id, 'Safari']]);
});

it('sends a reply as a message when a question appears as it is sent, shows the question, and answers it with the next reply', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.work(session);
  h.openai.say(session, 'Reading the code');
  await h.tick();
  let call;
  h.before(/^POST .*\/events$/, () => { call = h.openai.ask(session, 'Which browser?'); });
  await reply(h, 'Also fix Firefox');
  await h.tick();
  assert.deepEqual(sent(h), [['message', 'Also fix Firefox']], 'the user had not seen the question, so the reply is not its answer');
  assert.deepEqual(questions(h), [[2, 'Which browser?']], 'the question is shown although the message is not picked up');
  await reply(h, 'Safari');
  assert.deepEqual(sent(h).at(-1), ['result', call.call_id, 'Safari']);
  h.openai.work(session);
  h.openai.say(session, 'Fixed both', 'final_answer');
  h.openai.finish(session);
  await h.tick();
  assert.deepEqual(h.shortcut.activities().filter((a) => a.content.type === 'response').map((a) => [a.turn, a.content.body]), [[3, 'Fixed both']]);
});

it('sends a reply as a message when the session waits on a question the bridge never showed', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.work(session);
  h.openai.say(session, 'Fixed it', 'final_answer');
  h.openai.finish(session);
  await h.tick();
  session.inbox.push({ kind: 'message', text: 'Sent from elsewhere' });
  const call = h.openai.ask(session, 'Which browser?');
  await reply(h, 'Also fix Firefox');
  await h.tick();
  assert.deepEqual(sent(h), [['message', 'Also fix Firefox']]);
  assert.deepEqual(questions(h), [[2, 'Which browser?']]);
  await reply(h, 'Safari');
  assert.deepEqual(sent(h).at(-1), ['result', call.call_id, 'Safari']);
});

it('answers a call once: a second reply while the answered call is still listed goes as a message', async (t) => {
  const h = setup(t);
  const session = await h.started();
  const call = h.openai.ask(session, 'Which browser?');
  await h.tick();
  await reply(h, 'Safari');
  await h.tick();
  await reply(h, 'Actually Chrome');
  await h.tick();
  assert.deepEqual(sent(h), [['result', call.call_id, 'Safari'], ['message', 'Actually Chrome']]);
  assert.deepEqual(questions(h), [[1, 'Which browser?']], 'the answered call is not shown as a question again');
  h.openai.work(session);
  h.openai.say(session, 'Fixed Chrome', 'final_answer');
  h.openai.finish(session);
  await h.tick();
  assert.deepEqual(h.shortcut.activities().filter((a) => a.content.type === 'response').map((a) => [a.turn, a.content.body]), [[3, 'Fixed Chrome']]);
});

it('forgets an answered call once the session no longer lists it', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.ask(session, 'Which browser?');
  await h.tick();
  await reply(h, 'Safari');
  h.openai.work(session);
  const again = h.openai.ask(session, 'Which OS?');
  await h.tick();
  assert.deepEqual(questions(h), [[1, 'Which browser?'], [2, 'Which OS?']]);
  await reply(h, 'macOS');
  assert.deepEqual(sent(h).at(-1), ['result', again.call_id, 'macOS']);
});
