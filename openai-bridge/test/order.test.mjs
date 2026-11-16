// An accepted input is not in the items until the agent picks it up, so the
// bridge can send one while an earlier one is still on its way.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { SID, setup } from './harness.mjs';

const outcomes = (h, turn) => h.shortcut.activities().filter((a) => a.content.type !== 'thought' && a.turn === turn).map((a) => [a.content.type, a.content.body]);
const settle = async (h) => { for (let i = 0; i < 3; i++) await h.tick(); };

function answer(h, session, text) {
  h.openai.say(session, text, 'final_answer');
  h.openai.finish(session);
}

async function repliedTwice(h, first, second) {
  const session = await h.started();
  h.openai.work(session);
  answer(h, session, 'Fixed it');
  await h.tick();
  await h.deliver(h.shortcut.prompt(SID, first));
  await h.tick();
  await h.deliver(h.shortcut.prompt(SID, second));
  await h.tick();
  assert.deepEqual(session.received, [first, second]);
  return session;
}

for (const [what, first, second] of [['', 'Reply A', 'Reply B'], [' with the same words', 'Yes', 'Yes']]) {
  it(`answers the newest reply from its own turn when the reply before it${what} runs as a turn first`, async (t) => {
    const h = setup(t);
    const session = await repliedTwice(h, first, second);
    h.openai.work(session, 1);
    answer(h, session, 'Answer to the first');
    await settle(h);
    assert.deepEqual(outcomes(h, 3), [], 'the first reply\'s answer is not the second reply\'s');
    h.openai.work(session);
    h.openai.say(session, 'On the second');
    await h.tick();
    answer(h, session, 'Answer to the second');
    await h.tick();
    assert.deepEqual(h.shortcut.activities().filter((a) => a.turn === 3).map((a) => a.content.body), ['Passing your message to OpenAI.', 'On the second', 'Answer to the second']);
  });
}

it('ends the newest reply\'s turn with its own turn\'s failure, not with the answer to the reply before it', async (t) => {
  const h = setup(t);
  const session = await repliedTwice(h, 'Reply A', 'Reply B');
  h.openai.work(session, 1);
  answer(h, session, 'Answer to A');
  h.openai.work(session);
  h.openai.failTurn(session, 'server_overloaded');
  await settle(h);
  assert.deepEqual(outcomes(h, 3), [['error', 'The OpenAI turn failed (server_overloaded). Reply to try again.']]);
});

it('answers a reply that arrived during the start from its own turn, not from the opening turn', async (t) => {
  const h = setup(t);
  await h.connect();
  await h.deliver(h.shortcut.open());
  await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox'));
  await h.tick();
  await h.tick();
  const session = h.openai.only();
  assert.deepEqual(session.received, ['Also fix Firefox']);
  h.openai.work(session, 1);
  answer(h, session, 'Fixed the login');
  await settle(h);
  assert.deepEqual(outcomes(h, 2), []);
  h.openai.work(session);
  answer(h, session, 'Fixed Firefox too');
  await h.tick();
  assert.deepEqual(outcomes(h, 2), [['response', 'Fixed Firefox too']]);
});

it('finds the reply behind more than 1,000 items of the turn before it', async (t) => {
  const h = setup(t);
  const session = await repliedTwice(h, 'Reply A', 'Reply B');
  h.openai.work(session, 1);
  for (let i = 0; i < 1001; i++) session.items.push({ id: `rs_${i}`, type: 'reasoning', status: 'completed', summary: [], turn_id: session.turns.at(-1).id });
  answer(h, session, 'Answer to A');
  h.openai.work(session);
  answer(h, session, 'Answer to B');
  await settle(h);
  assert.deepEqual(outcomes(h, 3), [['response', 'Answer to B']]);
});

it('takes no message another client sent for the reply', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.work(session);
  answer(h, session, 'Fixed it');
  await h.tick();
  await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox'));
  await h.tick();
  session.inbox.unshift({ kind: 'message', text: 'Sent from elsewhere' });
  h.openai.work(session, 1);
  answer(h, session, 'Answer for elsewhere');
  await settle(h);
  assert.deepEqual(outcomes(h, 2), []);
  h.openai.work(session);
  answer(h, session, 'Fixed Firefox too');
  await h.tick();
  assert.deepEqual(outcomes(h, 2), [['response', 'Fixed Firefox too']]);
});

it('answers a reply although the one before it never shows up in the items, and the next one with the same words too', async (t) => {
  const h = setup(t);
  const session = await repliedTwice(h, 'Reply A', 'Reply B');
  session.inbox.shift();
  h.openai.work(session);
  answer(h, session, 'Answer to B');
  await h.tick();
  assert.deepEqual(outcomes(h, 3), [['response', 'Answer to B']]);
  await h.deliver(h.shortcut.prompt(SID, 'Reply B'));
  await settle(h);
  assert.deepEqual(outcomes(h, 4), [], 'the search starts after the message already found');
  h.openai.work(session);
  answer(h, session, 'Answer to B again');
  await h.tick();
  assert.deepEqual(outcomes(h, 4), [['response', 'Answer to B again']]);
});

it('forgets the earlier messages it has seen: a later reply with the words of one is found', async (t) => {
  const h = setup(t);
  const session = await repliedTwice(h, 'Reply A', 'Reply B');
  h.openai.work(session, 1);
  answer(h, session, 'Answer to A');
  h.openai.work(session);
  answer(h, session, 'Answer to B');
  await settle(h);
  await h.deliver(h.shortcut.prompt(SID, 'Reply A'));
  await h.tick();
  h.openai.work(session);
  answer(h, session, 'Answer to A again');
  await settle(h);
  assert.deepEqual(outcomes(h, 4), [['response', 'Answer to A again']]);
});

it('tells three replies in a row apart when the first and the third have the same words', async (t) => {
  const h = setup(t);
  const session = await repliedTwice(h, 'Yes', 'No');
  await h.deliver(h.shortcut.prompt(SID, 'Yes'));
  await h.tick();
  h.openai.work(session, 1);
  answer(h, session, 'Answer to the first yes');
  h.openai.work(session, 1);
  answer(h, session, 'Answer to no');
  await settle(h);
  assert.deepEqual(outcomes(h, 4), []);
  h.openai.work(session);
  answer(h, session, 'Answer to the second yes');
  await h.tick();
  assert.deepEqual(outcomes(h, 4), [['response', 'Answer to the second yes']]);
});

it('finds a reply with the words of the one before it, which the agent picked up before the bridge looked', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.work(session);
  answer(h, session, 'Fixed it');
  await h.tick();
  await h.deliver(h.shortcut.prompt(SID, 'Yes'));
  await h.tick();
  h.openai.work(session);
  await h.deliver(h.shortcut.prompt(SID, 'Yes'));
  await h.tick();
  h.openai.work(session);
  answer(h, session, 'Did both');
  await settle(h);
  assert.deepEqual(outcomes(h, 3), [['response', 'Did both']]);
});

it('ends the turn after 10 minutes when the agent does not pick up an answer to its question', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.ask(session, 'Which browser?');
  await h.tick();
  await h.deliver(h.shortcut.prompt(SID, 'Safari'));
  const started = Date.now();
  while (outcomes(h, 2).length === 0 && Date.now() - started < 700_000) await h.tick();
  assert.deepEqual(outcomes(h, 2), [['error', 'OpenAI did not pick up your reply. Reply to try again.']]);
  assert.ok(Date.now() - started >= 600_000);
});
