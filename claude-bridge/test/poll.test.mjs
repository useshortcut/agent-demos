import assert from 'node:assert/strict';
import { it } from 'node:test';
import { SID, consoleUrl, openingText, setup, typed, until } from './harness.mjs';

/** Turn 1 ends the way `end` leaves the session, then a reply follows. Returns the error and where the reply went. */
async function failedThenReplied(t, end) {
  const h = setup(t, { linked: false });
  const session = await h.started();
  h.claude.say(session, 'Working on it');
  end(h, session);
  await until(h, () => typed(h, 'error').length > 0, 'reports the failure');
  assert.deepEqual(typed(h, 'response'), []);
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Try again'))).status, 200);
  const told = (s) => s.received.some((text) => text.includes('Try again'));
  await until(h, () => h.claude.sessions.some(told), 'sends the reply');
  h.assertCleanLogs();
  return { error: typed(h, 'error'), same: told(session), sessions: h.claude.sessions.length };
}

const KEPT = { same: true, sessions: 1 };
const REPLACED = { same: false, sessions: 2 };

it('ends the turn, and starts a new session for the reply, when the session runs out of retries', async (t) => {
  const { error, ...where } = await failedThenReplied(t, (h, s) => h.claude.idle(s, { type: 'retries_exhausted' }));
  assert.deepEqual(error, [[1, 'The Claude session stopped after it ran out of retries. Reply to start a new one.']]);
  assert.deepEqual(where, REPLACED);
});

it('ends the turn with the refusal category, and sends the reply to the same session', async (t) => {
  const { error, ...where } = await failedThenReplied(t, (h, s) => h.claude.idle(s, { type: 'refusal' }, { type: 'refusal', category: 'cyber', explanation: 'private-explanation' }));
  assert.deepEqual(error, [[1, 'Claude declined to continue (cyber). Reply to try again.']]);
  assert.deepEqual(where, KEPT);
});

it('names a custom tool the bridge cannot run, and starts a new session for the reply', async (t) => {
  const { error, ...where } = await failedThenReplied(t, (h, s) => h.claude.call(s, 'deploy_site', { target: 'private-input' }));
  assert.deepEqual(error, [[1, 'The Claude session called the custom tool `deploy_site`, which Claude Bridge cannot run. Reply to start a new session.']]);
  assert.deepEqual(where, REPLACED);
});

it('says the bridge cannot approve a tool call, and starts a new session for the reply', async (t) => {
  const { error, ...where } = await failedThenReplied(t, (h, s) => h.claude.confirm(s, 'bash'));
  assert.deepEqual(error, [[1, 'The Claude session is waiting for a tool call to be approved, and Claude Bridge cannot approve one. Give the agent\'s tools a permission policy that needs no confirmation, then reply to start a new session.']]);
  assert.deepEqual(where, REPLACED);
});

it('ends the turn, and starts a new session for the reply, when the session is terminated', async (t) => {
  const { error, ...where } = await failedThenReplied(t, (h, s) => h.claude.terminate(s));
  assert.deepEqual(error, [[1, 'The Claude session was terminated. Reply to start a new one.']]);
  assert.deepEqual(where, REPLACED);
});

it('names a stop reason it does not know, and sends the reply to the same session', async (t) => {
  const { error, ...where } = await failedThenReplied(t, (h, s) => h.claude.idle(s, { type: 'paused_for_review' }));
  assert.deepEqual(error, [[1, 'The Claude session stopped (paused_for_review). Reply to try again.']]);
  assert.deepEqual(where, KEPT);
});

it('gives up on a reply the agent never takes after the pickup timeout', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.claude.say(session, 'Fixed it');
  h.claude.finish(session);
  await until(h, () => typed(h, 'response').length === 1, 'answers turn 1');
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox'))).status, 200);
  await until(h, () => typed(h, 'error').length > 0, 'gives up');
  assert.deepEqual(typed(h, 'error'), [[2, `Claude did not pick up your reply. Reply to try again. [Open in Claude Console](${consoleUrl(session)})`]]);
  assert.deepEqual(typed(h, 'thought').filter(([turn]) => turn === 2).map(([, body]) => body), ['Passing your message to Claude.'], 'the last turn\'s answer is never posted as this one\'s');
  assert.deepEqual(session.received, [openingText(), 'Also fix Firefox']);
});

it('posts the question as the last thing the agent said, after its progress', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.claude.say(session, 'Reading the login code');
  await until(h, () => typed(h, 'thought').some(([, body]) => body === 'Reading the login code'), 'posts progress');
  h.claude.say(session, 'Found two candidates');
  h.claude.ask(session, 'Which browser?');
  await until(h, () => typed(h, 'elicitation').length > 0, 'asks');
  assert.deepEqual(typed(h, 'elicitation'), [[1, `Which browser?\n\n[Open in Claude Console](${consoleUrl(session)})`]]);
  const before = h.requests.length;
  for (let i = 0; i < 3; i++) await h.tick();
  assert.equal(h.requests.length, before, 'the turn is handed back');
});

it('reports a reply queued behind a running turn as working, and answers it when the agent gets to it', async (t) => {
  const h = setup(t, { linked: false });
  const session = await h.started();
  h.claude.work(session);
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox'))).status, 200);
  await until(h, () => session.received.length === 2, 'sends the reply');
  const sentAt = Date.now();
  for (let i = 0; i < 30; i++) {
    h.claude.say(session, `Still on Safari ${i}`);
    await h.tick();
  }
  assert.deepEqual(typed(h, 'error'), [], 'a reply the running turn has not reached yet is not one the agent never picked up');
  assert.ok(Date.now() - sentAt > 15 * 60_000, 'the turn before runs past the pickup timeout');
  assert.deepEqual([...new Set(typed(h, 'thought').filter(([turn]) => turn === 2).map(([, body]) => body))], ['Passing your message to Claude.', 'Claude is still working.'],
    'what the turn before says is not this turn\'s progress');
  h.claude.finish(session);
  h.claude.say(session, 'Firefox fixed');
  h.claude.finish(session);
  await until(h, () => typed(h, 'response').some(([turn]) => turn === 2), 'answers the reply');
  assert.deepEqual(typed(h, 'response'), [[2, 'Firefox fixed']]);
});

it('posts the answer of a turn that finished before the session was terminated, and starts a new session for the reply', async (t) => {
  const h = setup(t, { linked: false });
  const session = await h.started();
  h.claude.say(session, 'Fixed it');
  h.claude.finish(session);
  h.claude.terminate(session);
  await until(h, () => h.shortcut.activities().some((a) => a.content.type !== 'thought'), 'ends the turn');
  assert.deepEqual([typed(h, 'response'), typed(h, 'error')], [[[1, 'Fixed it']], []]);
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox'))).status, 200);
  await until(h, () => h.claude.sessions.length === 2 && h.claude.sessions[1].received.length > 0, 'opens a new session');
  assert.deepEqual(h.claude.sessions[1].received, [openingText('Also fix Firefox')]);
});

it('posts nothing an interrupted turn says while it winds down as the answer to the reply behind it', async (t) => {
  const h = setup(t, { linked: false });
  const session = await h.started();
  h.claude.say(session, 'Working on it');
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Try Chrome instead'))).status, 200);
  await until(h, () => session.received.length === 2, 'sends the reply');
  h.claude.mutter(session, 'Half-finished Safari patch');
  for (let i = 0; i < 3; i++) await h.tick();
  h.claude.settle(session);
  for (let i = 0; i < 3; i++) await h.tick();
  assert.deepEqual(h.shortcut.activities().filter((a) => a.turn === 2 && a.content.body.includes('Safari')), []);
  assert.deepEqual(typed(h, 'response'), [], 'the idle that ends the interrupted turn is not this turn\'s');
  h.claude.say(session, 'Chrome works');
  h.claude.finish(session);
  await until(h, () => typed(h, 'response').length > 0, 'answers the reply');
  assert.deepEqual(typed(h, 'response'), [[2, 'Chrome works']]);
});

it('joins the text blocks of a message, and skips a message with no text', async (t) => {
  const h = setup(t, { linked: false });
  const session = await h.started();
  h.claude.emit(session, { type: 'agent.message', content: [{ type: 'text', text: 'Fixed ' }, { type: 'redacted', text: 'private-redacted' }, { type: 'text', text: 'the login bug' }] });
  await until(h, () => typed(h, 'thought').length === 2, 'posts progress');
  h.claude.emit(session, { type: 'agent.message', content: [] });
  h.claude.emit(session, { type: 'agent.message' });
  for (let i = 0; i < 3; i++) await h.tick();
  assert.deepEqual(typed(h, 'thought').map(([, body]) => body), ['Starting a Claude session.', 'Fixed the login bug']);
  h.claude.finish(session);
  await until(h, () => typed(h, 'response').length > 0, 'answers');
  assert.deepEqual(typed(h, 'response'), [[1, 'Fixed the login bug']], 'the last message with text is the answer');
});

it('reports a finished turn with no message at all', async (t) => {
  const h = setup(t, { linked: false });
  const session = await h.started();
  h.claude.finish(session);
  await until(h, () => typed(h, 'response').length > 0, 'answers');
  assert.deepEqual(typed(h, 'response'), [[1, 'Claude finished.']]);
});

it('names an idle with no stop reason as unknown, and sends the reply to the same session', async (t) => {
  const { error, ...where } = await failedThenReplied(t, (h, s) => h.claude.idle(s, undefined));
  assert.deepEqual(error, [[1, 'The Claude session stopped (unknown). Reply to try again.']]);
  assert.deepEqual(where, KEPT);
});

it('leaves a stop reason, a refusal category, and a tool name that are not plain identifiers out of the error', async (t) => {
  const reason = await failedThenReplied(t, (h, s) => h.claude.idle(s, { type: 'private reason' }));
  assert.deepEqual(reason.error, [[1, 'The Claude session stopped (unknown). Reply to try again.']]);
  const refusal = await failedThenReplied(t, (h, s) => h.claude.idle(s, { type: 'refusal' }, { type: 'refusal', category: 'private category', explanation: 'private-explanation' }));
  assert.deepEqual(refusal.error, [[1, 'Claude declined to continue. Reply to try again.']]);
  const uncategorized = await failedThenReplied(t, (h, s) => h.claude.idle(s, { type: 'refusal' }));
  assert.deepEqual(uncategorized.error, [[1, 'Claude declined to continue. Reply to try again.']]);
  const tool = await failedThenReplied(t, (h, s) => h.claude.call(s, 'private tool', {}));
  assert.deepEqual(tool.error, [[1, 'The Claude session called a custom tool, which Claude Bridge cannot run. Reply to start a new session.']]);
});

it('retries a poll whose event list holds an event with no id', async (t) => {
  const h = setup(t, { linked: false });
  const session = await h.started();
  h.claude.say(session, 'Fixed it');
  h.claude.finish(session);
  session.events.push({ type: 'agent.message', content: [{ type: 'text', text: 'private-text' }], processed_at: '2026-10-01T01:00:00.000Z' });
  for (let i = 0; i < 3; i++) await h.tick();
  assert.deepEqual(h.shortcut.activities().map((a) => a.content.type), ['thought'], 'a list it cannot read whole decides nothing');
  session.events.pop();
  await until(h, () => typed(h, 'response').length > 0, 'answers');
  assert.deepEqual([typed(h, 'response'), typed(h, 'error')], [[[1, 'Fixed it']], []]);
  h.assertCleanLogs();
});

it('reports a turn that ends without a message as finished, not with what the agent said before the question', async (t) => {
  const h = setup(t, { linked: false });
  const session = await h.started();
  h.claude.say(session, 'Found two candidates');
  h.claude.ask(session, 'Which browser?');
  await until(h, () => typed(h, 'elicitation').length > 0, 'asks');
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Safari'))).status, 200);
  await until(h, () => session.received.length === 2, 'answers');
  h.claude.finish(session);
  await until(h, () => typed(h, 'response').length > 0, 'ends the turn');
  assert.deepEqual(typed(h, 'response'), [[2, 'Claude finished.']]);
});

it('ends the turn with an error, not a question, when the session is terminated while it waits on ask_user', async (t) => {
  const h = setup(t, { linked: false });
  const session = await h.started();
  h.claude.ask(session, 'Which browser?');
  h.claude.terminate(session);
  await until(h, () => h.shortcut.activities().some((a) => a.content.type !== 'thought'), 'ends the turn');
  assert.deepEqual([typed(h, 'elicitation'), typed(h, 'error')], [[], [[1, 'The Claude session was terminated. Reply to start a new one.']]]);
});
