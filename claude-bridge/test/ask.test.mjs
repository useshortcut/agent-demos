import assert from 'node:assert/strict';
import { it } from 'node:test';
import { SID, finished, openingText, setup, typed, until } from './harness.mjs';

const SEND = /^POST \/v1\/sessions\/[^/]+\/events$/;
const result = (call, text) => ({ type: 'user.custom_tool_result', custom_tool_use_id: call.id, content: [{ type: 'text', text }] });
const reply = async (h, text) => assert.equal((await h.deliver(h.shortcut.prompt(SID, text))).status, 200);

it('shows parallel ask_user questions one at a time, and answers each call with the reply to its question', async (t) => {
  const h = setup(t, { linked: false });
  const session = await h.started();
  const [browser, os] = h.claude.calls(session, [['ask_user', { question: 'Which browser?' }], ['ask_user', { question: 'Which OS?' }]]);
  await until(h, () => typed(h, 'elicitation').length === 1, 'asks the first question');
  await reply(h, 'Safari');
  await until(h, () => typed(h, 'elicitation').length === 2, 'asks the second question');
  await reply(h, 'macOS');
  await until(h, () => session.received.length === 3, 'answers the second call');
  assert.deepEqual(typed(h, 'elicitation'), [[1, 'Which browser?'], [2, 'Which OS?']]);
  assert.deepEqual(h.sent().slice(1), [result(browser, 'Safari'), result(os, 'macOS')]);
  await finished(h, session, 'Fixed Safari on macOS');
  assert.deepEqual([typed(h, 'response'), typed(h, 'error')], [[[3, 'Fixed Safari on macOS']], []]);
  h.assertCleanLogs();
});

it('answers the question it showed while the session status still says running, on every retry of the send', async (t) => {
  const h = setup(t, { linked: false });
  const session = await h.started();
  const call = h.claude.ask(session, 'Which browser?');
  await until(h, () => typed(h, 'elicitation').length === 1, 'asks');
  h.claude.state.lag = true;
  h.claude.failNext(503, {}, SEND);
  h.claude.failNext(503, {}, SEND);
  await reply(h, 'Safari');
  await until(h, () => session.received.length === 2, 'answers the call');
  assert.deepEqual(h.sent().slice(1), [result(call, 'Safari'), result(call, 'Safari'), result(call, 'Safari')]);
  await finished(h, session, 'Fixed Safari');
  assert.deepEqual(typed(h, 'error'), []);
});

const crossed = (text) => `The user has not seen this question. They sent this message before it reached them:\n\n${text}\n\nAsk again if you still need an answer.`;

it('never sends a reply as the answer to a question the user did not see, and shows the question once the agent asks again', async (t) => {
  const h = setup(t, { linked: false });
  const session = await h.started();
  h.claude.say(session, 'Working on it');
  await until(h, () => typed(h, 'thought').some(([, body]) => body === 'Working on it'), 'posts progress');
  const unseen = h.claude.ask(session, 'Delete the production database?');
  await reply(h, 'Also update the changelog');
  await until(h, () => session.received.length === 2, 'the session takes the message');
  assert.deepEqual(h.sent().slice(1), [result(unseen, crossed('Also update the changelog'))]);
  const again = h.claude.ask(session, 'Delete the production database?');
  await until(h, () => typed(h, 'elicitation').length === 1, 'asks');
  assert.deepEqual(typed(h, 'elicitation'), [[2, 'Delete the production database?']]);
  await reply(h, 'No');
  await until(h, () => session.received.length === 3, 'answers the question the user saw');
  assert.deepEqual(h.sent().at(-1), result(again, 'No'));
  assert.deepEqual(typed(h, 'error'), []);
  h.assertCleanLogs();
});

it('gives the session a reply whose first send failed before the agent asked a question', async (t) => {
  const h = setup(t, { linked: false });
  const session = await h.started();
  h.claude.say(session, 'Working on it');
  await until(h, () => typed(h, 'thought').some(([, body]) => body === 'Working on it'), 'posts progress');
  h.claude.failNext(503, {}, SEND);
  await reply(h, 'Use Safari');
  await until(h, () => h.sent().length === 2, 'tries the send');
  const unseen = h.claude.ask(session, 'Which browser?');
  await until(h, () => session.received.length === 2, 'the session takes the message');
  assert.deepEqual(h.sent().slice(1), [{ type: 'user.message', content: [{ type: 'text', text: 'Use Safari' }] }, result(unseen, crossed('Use Safari'))]);
  assert.deepEqual([typed(h, 'elicitation'), typed(h, 'error')], [[], []]);
});

it('answers the call the session waits on when another ask_user call beside it is already answered', async (t) => {
  const h = setup(t, { linked: false });
  const session = await h.started();
  h.claude.say(session, 'Working on it');
  await until(h, () => typed(h, 'thought').some(([, body]) => body === 'Working on it'), 'posts progress');
  const [answered, waiting] = h.claude.calls(session, [['ask_user', { question: 'Which browser?' }], ['ask_user', { question: 'Which OS?' }]]);
  h.claude.answer(session, answered, 'Safari');
  await until(h, () => typed(h, 'elicitation').length === 1, 'asks');
  assert.deepEqual(typed(h, 'elicitation'), [[1, 'Which OS?']], 'the idle names the call that still waits');
  await reply(h, 'macOS');
  await until(h, () => session.received.includes('macOS'), 'answers');
  assert.deepEqual(h.sent().slice(1), [result(waiting, 'macOS')]);
});

it('gives a crossing reply to the call the session waits on, not to an answered call beside it', async (t) => {
  const h = setup(t, { linked: false });
  const session = await h.started();
  h.claude.say(session, 'Working on it');
  await until(h, () => typed(h, 'thought').some(([, body]) => body === 'Working on it'), 'posts progress');
  const [waiting, answered] = h.claude.calls(session, [['ask_user', { question: 'Which browser?' }], ['ask_user', { question: 'Which OS?' }]]);
  h.claude.answer(session, answered, 'macOS');
  await reply(h, 'Also update the changelog');
  await until(h, () => session.received.length === 3, 'the session takes the message');
  assert.deepEqual(h.sent().slice(1), [result(waiting, crossed('Also update the changelog'))]);
});

it('sends a reply as a message once the question before it is answered and the agent works again', async (t) => {
  const h = setup(t, { linked: false });
  const session = await h.started();
  h.claude.ask(session, 'Which browser?');
  await until(h, () => typed(h, 'elicitation').length === 1, 'asks');
  await reply(h, 'Safari');
  await until(h, () => session.received.length === 2, 'answers');
  await reply(h, 'And Firefox');
  await until(h, () => session.received.length === 3, 'sends the next reply');
  assert.deepEqual(h.sent().at(-1), { type: 'user.message', content: [{ type: 'text', text: 'And Firefox' }] });
});

it('finds the question it showed, and the call a reply crosses, in a session with more calls than one lookup reads', async (t) => {
  const h = setup(t, { linked: false });
  const session = await h.started();
  for (let round = 1; round <= 21; round++) {
    const call = h.claude.ask(session, `Question ${round}?`);
    await until(h, () => typed(h, 'elicitation').length === round, `asks question ${round}`);
    if (round === 21) h.claude.state.lose = 'send';
    await reply(h, `Answer ${round}`);
    await until(h, () => session.received.length === round + 1, `answers question ${round}`);
    assert.deepEqual(h.sent().at(-1), result(call, `Answer ${round}`));
  }
  await finished(h, session, 'All answered');
  assert.equal(h.sent().length, 22, 'the result whose answer was lost is found in the list, not sent again');
  const unseen = h.claude.ask(session, 'One more?');
  await reply(h, 'Thanks');
  await until(h, () => session.received.length === 23, 'the session takes the message');
  assert.deepEqual(h.sent().at(-1), result(unseen, crossed('Thanks')));
  assert.deepEqual(typed(h, 'error'), []);
});

it('asks for input in its own words when an ask_user call carries no question', async (t) => {
  const h = setup(t, { linked: false });
  const session = await h.started();
  const call = h.claude.call(session, 'ask_user', {});
  await until(h, () => typed(h, 'elicitation').length === 1, 'asks');
  assert.deepEqual(typed(h, 'elicitation'), [[1, 'Claude is waiting for your input.']]);
  await reply(h, 'Safari');
  await until(h, () => session.received.length === 2, 'answers');
  assert.deepEqual(h.sent().at(-1), result(call, 'Safari'));
});

it('answers no call it cannot run with a reply that crosses it', async (t) => {
  const h = setup(t, { linked: false });
  const session = await h.started();
  h.claude.say(session, 'Working on it');
  await until(h, () => typed(h, 'thought').some(([, body]) => body === 'Working on it'), 'posts progress');
  h.claude.call(session, 'deploy_site', { target: 'private-input' });
  await reply(h, 'Also update the changelog');
  await until(h, () => typed(h, 'error').length > 0, 'ends the turn');
  assert.deepEqual(h.sent().map((event) => event.type).filter((type) => type !== 'user.interrupt'), ['user.message', 'user.message'], 'the call gets no result');
  assert.deepEqual(typed(h, 'error'), [[2, 'Claude rejected the request (HTTP 400). Reply to start a new Claude session.']]);
});
