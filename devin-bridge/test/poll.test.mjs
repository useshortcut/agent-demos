import assert from 'node:assert/strict';
import { it } from 'node:test';
import { SID, assertAbout, setup } from './harness.mjs';

it('posts only the newest new Devin message as one ephemeral thought and backs off while nothing changes', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  h.devin.say(devin, 'Cloning the repo (private-devin-text)');
  h.devin.say(devin, 'Reading the login code (private-devin-text)');
  await h.tick();
  const progress = () => h.shortcut.activities().filter((a) => a.key.includes(':message:'));
  assert.deepEqual(progress(), [{ key: 'devin-bridge:1:message:evt-2', turn: 1, content: { type: 'thought', body: 'Reading the login code (private-devin-text)' }, ephemeral: true }]);
  assertAbout(await h.alarmIn(), 5_000, 'after progress');

  for (const expected of [10_000, 20_000, 40_000, 60_000, 60_000]) {
    await h.tick();
    assertAbout(await h.alarmIn(), expected, 'quiet poll');
  }
  h.env.SESSIONS.restart();
  await h.tick();
  assertAbout(await h.alarmIn(), 60_000, 'quiet poll after restart');
  assert.equal(progress().length, 1);

  h.devin.say(devin, 'Found it (private-devin-text)');
  await h.tick();
  assert.deepEqual(progress().map((a) => a.key), ['devin-bridge:1:message:evt-2', 'devin-bridge:1:message:evt-3']);
  assertAbout(await h.alarmIn(), 5_000, 'progress resets the delay');
  for (const key of ['evt-1', 'evt-2', 'evt-3']) assert.ok(h.posts(new RegExp(`message:${key}$`)).length <= 1, `${key} posted at most once`);
  h.assertCleanLogs();
});

it('finishes the turn with Devin\'s last message, its pull requests, and the Devin link, then stops polling', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished', pull_requests: [{ pr_url: 'https://github.com/acme/app/pull/7', pr_state: 'open' }] });
  h.devin.say(devin, 'Fixed the Safari login bug (private-devin-text)');
  await h.tick();
  const responses = h.shortcut.activities().filter((a) => a.content.type === 'response');
  assert.equal(responses.length, 1);
  const [response] = responses;
  assert.equal(response.turn, 1);
  assert.equal(response.ephemeral, undefined);
  assert.match(response.content.body, /Fixed the Safari login bug/);
  assert.match(response.content.body, /https:\/\/github\.com\/acme\/app\/pull\/7/);
  assert.ok(response.content.body.includes(`[Open in Devin](${devin.url})`));
  assert.equal(await h.alarmIn(), null);
  h.assertCleanLogs();
});

for (const [label, status, detail, pattern] of [
  ['an errored', 'error', null, /ended with an error/],
  ['a suspended', 'suspended', 'inactivity', /suspended \(inactivity\)/],
  ['an externally terminated', 'exit', null, /terminated in Devin/],
]) {
  it(`reports ${label} Devin session as an error and stops polling`, async (t) => {
    const h = setup(t);
    const devin = await h.started();
    Object.assign(devin, { status, status_detail: detail });
    await h.tick();
    const errors = h.shortcut.activities().filter((a) => a.content.type === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].key, 'devin-bridge:1:error');
    assert.match(errors[0].content.body, pattern);
    assert.equal(await h.alarmIn(), null);
  });
}

it('hands the turn back with an elicitation carrying Devin\'s question when Devin waits on the user', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'waiting_for_user' });
  h.devin.say(devin, 'Which branch should I use? (private-devin-text)');
  await h.tick();
  const [elicitation] = h.shortcut.activities().filter((a) => a.content.type === 'elicitation');
  assert.equal(elicitation.key, 'devin-bridge:1:elicitation:evt-1');
  assert.match(elicitation.content.body, /Which branch should I use\?/);
  assert.ok(elicitation.content.body.includes(devin.url));
  assert.equal(await h.alarmIn(), null);
});

it('relays a follow-up into the same Devin session and answers on the new turn', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  h.devin.say(devin, 'Safari fixed (private-devin-text)');
  await h.tick();
  assert.equal(h.shortcut.activities().filter((a) => a.content.type === 'response').length, 1);

  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox (private-prompt)'))).status, 200);
  await h.tick();
  assert.deepEqual(devin.received, ['Also fix Firefox (private-prompt)']);
  const ack = h.shortcut.activities().find((a) => a.key === 'devin-bridge:2:ack');
  assert.equal(ack.turn, 2);
  assert.equal(ack.ephemeral, true);
  assertAbout(await h.alarmIn(), 5_000, 'polling resumes');

  await h.tick();
  assert.equal(h.shortcut.activities().filter((a) => a.turn === 2 && a.content.type === 'response').length, 0, 'a stale finished status is not the new answer');

  devin.status_detail = 'working';
  await h.tick();
  h.devin.say(devin, 'Firefox fixed too (private-devin-text)');
  devin.status_detail = 'finished';
  await h.tick();
  const [response] = h.shortcut.activities().filter((a) => a.turn === 2 && a.content.type === 'response');
  assert.equal(response.key, 'devin-bridge:2:response');
  assert.match(response.content.body, /Firefox fixed too/);
  assert.equal(h.devin.sessions.length, 1);
  assert.equal(await h.alarmIn(), null);
  h.assertCleanLogs();
});

it('places Devin\'s answer after the relayed reply whatever source Devin records the reply under', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'waiting_for_user' });
  h.devin.say(devin, 'Which branch? (private-devin-text)');
  await h.tick();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'main (private-prompt)'))).status, 200);
  await h.tick();
  devin.messages.at(-1).source = 'api';
  h.devin.say(devin, 'Thanks, which remote? (private-devin-text)');
  await h.tick();
  const [elicitation] = h.shortcut.activities().filter((a) => a.turn === 2 && a.content.type === 'elicitation');
  assert.match(elicitation.content.body, /which remote\?/);
});

it('answers a reply with only what Devin said after it, never the previous turn\'s message', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  h.devin.say(devin, 'Safari fixed (private-devin-text)');
  await h.tick();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox (private-prompt)'))).status, 200);
  await h.tick();
  devin.status_detail = 'working';
  await h.tick();
  devin.status_detail = 'finished';
  await h.tick();
  const [response] = h.shortcut.activities().filter((a) => a.turn === 2 && a.content.type === 'response');
  assert.equal(response.content.body.split('\n\n')[0], 'Devin finished.');
  assert.equal(await h.alarmIn(), null);

  const quiet = setup(t);
  const other = await quiet.started();
  Object.assign(other, { status: 'running', status_detail: 'waiting_for_user' });
  quiet.devin.say(other, 'Which branch? (private-devin-text)');
  await quiet.tick();
  assert.equal((await quiet.deliver(quiet.shortcut.prompt(SID, 'main (private-prompt)'))).status, 200);
  await quiet.tick();
  quiet.devin.say(other, 'Thanks, which remote? (private-devin-text)');
  await quiet.tick();
  const [elicitation] = quiet.shortcut.activities().filter((a) => a.turn === 2 && a.content.type === 'elicitation');
  assert.match(elicitation.content.body, /which remote\?/);
  assert.doesNotMatch(elicitation.content.body, /Which branch\?/);
  quiet.assertCleanLogs();
});

it('posts no progress and falls back to plain outcomes when the Devin message list is cut short', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  h.devin.say(devin, 'Cloning (private-devin-text)');
  h.devin.state.cutMessages = true;
  await h.tick();
  assert.equal(h.posts(/:message:/).length, 0);
  const warnings = () => h.logs.filter(([level, message]) => level === 'warn' && /message list/.test(message));
  assert.equal(warnings().length, 1);
  devin.status_detail = 'finished';
  await h.tick();
  const [response] = h.shortcut.activities().filter((a) => a.content.type === 'response');
  assert.equal(response.content.body.split('\n\n')[0], 'Devin finished.');
  assert.equal(warnings().length, 2);
  h.assertCleanLogs();
});

it('fits an outcome into Shortcut\'s body limit even when the footer alone is too long', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  const pulls = Array.from({ length: 1_500 }, (_, i) => ({ pr_url: `https://github.com/acme/app/pull/${1_000 + i}`, pr_state: 'open' }));
  Object.assign(devin, { status: 'running', status_detail: 'finished', pull_requests: pulls });
  h.devin.say(devin, `Fixed ${'x'.repeat(40_000)} (private-devin-text)`);
  await h.tick();
  const [response] = h.shortcut.activities().filter((a) => a.content.type === 'response');
  assert.ok(response.content.body.length <= 32_768);
  assert.equal(await h.alarmIn(), null);
});

it('keeps polling when Devin reports a status detail that is a property of every object', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'constructor' });
  await h.tick();
  assertAbout(await h.alarmIn(), 10_000, 'an unknown detail counts as working');
  assert.equal(h.shortcut.activities().length, 1);
});

it('ends the turn when Devin does not pick a reply up in 10 minutes, and the next reply reaches the same session', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  h.devin.say(devin, 'Done (private-devin-text)');
  await h.tick();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'One more thing (private-prompt)'))).status, 200);
  const relayedAt = Date.now();
  for (let i = 0; i < 30 && (await h.alarmIn()) !== null; i++) await h.tick();
  assert.equal(await h.alarmIn(), null);
  assert.ok(Date.now() - relayedAt >= 600_000 && Date.now() - relayedAt < 700_000, 'waited about 10 minutes');
  const [error] = h.shortcut.activities().filter((a) => a.turn === 2 && a.content.type === 'error');
  assert.match(error.content.body, /did not pick up/);
  assert.equal(devin.terminated, undefined, 'the Devin session is kept');
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Try again (private-prompt)'))).status, 200);
  await h.tick();
  assert.equal(h.devin.sessions.length, 1);
  assert.deepEqual(devin.received, ['One more thing (private-prompt)', 'Try again (private-prompt)']);
});

it('starts a new Devin session after Devin rejects a relay', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  await h.tick();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'More (private-prompt)'))).status, 200);
  h.devin.failNext(400);
  await h.tick();
  const [error] = h.shortcut.activities().filter((a) => a.turn === 2 && a.content.type === 'error');
  assert.match(error.content.body, /HTTP 400/);
  assert.match(error.content.body, /start a new Devin session/);
  assert.equal(devin.terminated, true, 'a session the bridge gives up on is terminated');
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Again (private-prompt)'))).status, 200);
  await h.tick();
  assert.equal(h.devin.sessions.length, 2);
  assert.deepEqual(devin.received, []);
});

it('waits as long as Devin reports working after a relay, and ends the turn once it answers', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  h.devin.say(devin, 'Working (private-devin-text)');
  await h.tick();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'More (private-prompt)'))).status, 200);
  await h.tick();
  const relayedAt = Date.now();
  for (let i = 0; i < 40 && Date.now() - relayedAt < 900_000; i++) await h.tick();
  assert.equal(h.shortcut.activities().filter((a) => a.turn === 2 && a.content.type === 'error').length, 0);
  assert.notEqual(await h.alarmIn(), null, 'still polling after 15 minutes');
  h.devin.say(devin, 'Done (private-devin-text)');
  devin.status_detail = 'finished';
  await h.tick();
  const [response] = h.shortcut.activities().filter((a) => a.turn === 2 && a.content.type === 'response');
  assert.match(response.content.body, /Done/);
});

it('takes any status change after a relay as pickup, even when the message list is cut short', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  h.devin.say(devin, 'Done (private-devin-text)');
  await h.tick();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'More (private-prompt)'))).status, 200);
  await h.tick();
  h.devin.state.cutMessages = true;
  devin.status_detail = 'waiting_for_user';
  await h.tick();
  const [elicitation] = h.shortcut.activities().filter((a) => a.turn === 2 && a.content.type === 'elicitation');
  assert.equal(elicitation.content.body.split('\n\n')[0], 'Devin is waiting for your input.');
  assert.equal(await h.alarmIn(), null);
});

it('places the reply from the start of an empty baseline, and treats a missing baseline as nothing fresh', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  await h.tick();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'More (private-prompt)'))).status, 200);
  await h.tick();
  devin.messages.unshift({ event_id: 'evt-old', source: 'devin', message: 'Old answer (private-devin-text)', created_at: 0 });
  await h.tick();
  assert.equal(h.shortcut.activities().filter((a) => a.turn === 2 && a.content.type === 'response').length, 0, 'a message before the reply is not its answer');
  h.devin.say(devin, 'New answer (private-devin-text)');
  await h.tick();
  const [response] = h.shortcut.activities().filter((a) => a.turn === 2 && a.content.type === 'response');
  assert.match(response.content.body, /New answer/);

  const moved = setup(t);
  const other = await moved.started();
  Object.assign(other, { status: 'running', status_detail: 'finished' });
  moved.devin.say(other, 'Done (private-devin-text)');
  await moved.tick();
  assert.equal((await moved.deliver(moved.shortcut.prompt(SID, 'More (private-prompt)'))).status, 200);
  await moved.tick();
  other.messages.shift();
  moved.devin.say(other, 'Late answer (private-devin-text)');
  await moved.tick();
  assert.equal(moved.shortcut.activities().filter((a) => a.turn === 2 && a.content.type === 'response').length, 0, 'without the baseline nothing is fresh');
  other.status_detail = 'working';
  await moved.tick();
  other.status_detail = 'finished';
  await moved.tick();
  const [plain] = moved.shortcut.activities().filter((a) => a.turn === 2 && a.content.type === 'response');
  assert.equal(plain.content.body.split('\n\n')[0], 'Devin finished.');
});

it('never cuts an outcome in the middle of a surrogate pair', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  const room = 32_768 - `[Open in Devin](${devin.url})`.length - 2;
  h.devin.say(devin, `${'x'.repeat(room - 2)}😀 tail (private-devin-text)`);
  await h.tick();
  const [response] = h.shortcut.activities().filter((a) => a.content.type === 'response');
  assert.ok(response.content.body.length <= 32_768);
  assert.ok(response.content.body.isWellFormed(), 'no lone surrogate');
});

it('counts a malformed Devin message toward a cut-short list', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  h.devin.say(devin, 'Cloning (private-devin-text)');
  h.devin.state.malformedMessages = true;
  await h.tick();
  assert.equal(h.posts(/:message:/).length, 0);
  assert.equal(h.logs.filter(([level, message]) => level === 'warn' && /message list/.test(message)).length, 1);
});

it('keeps polling after an approval elicitation, posts it once, and finishes the turn once Devin is approved and done', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'waiting_for_approval' });
  h.devin.say(devin, 'May I run the migration? (private-devin-text)');
  await h.tick();
  const elicitations = () => h.shortcut.activities().filter((a) => a.content.type === 'elicitation');
  assert.equal(elicitations().length, 1);
  assert.match(elicitations()[0].content.body, /May I run the migration\?/);
  assert.notEqual(await h.alarmIn(), null, 'still polling');
  await h.tick();
  await h.tick();
  assert.equal(h.posts(/:elicitation/).length, 1, 'the elicitation is posted once');
  devin.status_detail = 'working';
  h.devin.say(devin, 'Running it (private-devin-text)');
  await h.tick();
  assert.deepEqual(h.shortcut.activities().filter((a) => a.key.includes(':message:')).map((a) => a.key), ['devin-bridge:1:message:evt-2']);
  devin.status_detail = 'finished';
  h.devin.say(devin, 'Migrated (private-devin-text)');
  await h.tick();
  const [response] = h.shortcut.activities().filter((a) => a.content.type === 'response');
  assert.equal(response.turn, 1);
  assert.match(response.content.body, /Migrated/);
  assert.equal(await h.alarmIn(), null);
  h.assertCleanLogs();
});

it('reuses the baseline of a relay whose send reached Devin but lost its answer', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  h.devin.say(devin, 'Safari fixed (private-devin-text)');
  await h.tick();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox (private-prompt)'))).status, 200);
  h.devin.state.loseSend = true;
  await h.tick();
  assert.deepEqual(devin.received, ['Also fix Firefox (private-prompt)']);
  h.devin.say(devin, 'Firefox fixed (private-devin-text)');
  await h.tick();
  await h.tick();
  const responses = h.shortcut.activities().filter((a) => a.turn === 2 && a.content.type === 'response');
  assert.equal(responses.length, 1, 'the answer to the first send is not hidden behind the retry');
  assert.match(responses[0].content.body, /Firefox fixed/);
  assert.equal(await h.alarmIn(), null);
});

it('starts a new Devin session when a reply reaches one that has exited', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  h.devin.say(devin, 'Done (private-devin-text)');
  await h.tick();
  Object.assign(devin, { status: 'exit', status_detail: null });
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'One more (private-prompt)'))).status, 200);
  await h.tick();
  assert.equal(h.devin.sessions.length, 2);
  assert.deepEqual(devin.received, []);
  assert.match(h.devin.sessions[1].prompt, /One more/);
  assert.deepEqual(h.devin.sessions[1].tags, ['shortcut-session-sess-1-2']);
  assert.ok(h.shortcut.activities().some((a) => a.key === 'devin-bridge:2:restart'));
  assert.equal(h.devinCalls('DELETE').length, 1, 'the exited session is retired');
  assertAbout(await h.alarmIn(), 5_000, 'polling the new session');
});

it('wakes a suspended Devin session with the next reply', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'suspended', status_detail: 'inactivity' });
  await h.tick();
  assert.equal(await h.alarmIn(), null);
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Wake up (private-prompt)'))).status, 200);
  await h.tick();
  assert.equal(h.devin.sessions.length, 1);
  assert.deepEqual(devin.received, ['Wake up (private-prompt)']);
  assert.equal(h.devinCalls('DELETE').length, 0);
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  h.devin.say(devin, 'Awake and done (private-devin-text)');
  await h.tick();
  const [response] = h.shortcut.activities().filter((a) => a.turn === 2 && a.content.type === 'response');
  assert.match(response.content.body, /Awake and done/);
});

it('keeps only the newest progress thought while Shortcut is down, and still delivers the outcome', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  h.shortcut.state.serverErrors = 2;
  h.devin.say(devin, 'Cloning (private-devin-text)');
  await h.tick();
  h.devin.say(devin, 'Reading (private-devin-text)');
  await h.tick();
  h.devin.say(devin, 'Editing (private-devin-text)');
  await h.tick();
  await h.tick();
  const progress = () => h.shortcut.activities().filter((a) => a.key.includes(':message:')).map((a) => a.key);
  assert.deepEqual(progress(), ['devin-bridge:1:message:evt-3'], 'only the newest thought is posted once Shortcut is back');
  devin.status_detail = 'finished';
  h.devin.say(devin, 'Done (private-devin-text)');
  await h.tick();
  const [response] = h.shortcut.activities().filter((a) => a.content.type === 'response');
  assert.match(response.content.body, /Done/);
  assert.deepEqual(progress(), ['devin-bridge:1:message:evt-3']);
  assert.equal(await h.alarmIn(), null);
});

it('polls Devin no earlier than its due time on a duplicate delivery or an event that changes nothing', async (t) => {
  const h = setup(t);
  await h.connect();
  const event = h.shortcut.open();
  assert.equal((await h.deliver(event)).status, 200);
  await h.tick();
  const devin = h.devin.only();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  h.devin.say(devin, 'Cloning (private-devin-text)');
  const polls = () => h.devinCalls('GET', /\/sessions\/devin-1$/).length;
  assert.equal((await (await h.deliver(event)).json()).duplicate, true);
  assertAbout(await h.alarmIn(), 5_000, 'a duplicate keeps the alarm');
  assert.equal((await h.deliver(h.shortcut.prompt(SID, { type: 'attachment', url: 'https://files.example/private-file.png' }))).status, 200);
  await h.tick();
  assert.equal(polls(), 0, 'an event that changes nothing does not poll early');
  assertAbout(await h.alarmIn(), 5_000, 'the poll keeps its due time');
  await h.tick();
  assert.equal(polls(), 1);
  assert.equal(h.posts(/:message:/).length, 1);
});

it('counts a message page without a boolean has_next_page as cut short', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  h.devin.say(devin, 'Cloning (private-devin-text)');
  h.devin.state.messagePatch = { has_next_page: undefined, end_cursor: '2' };
  await h.tick();
  assert.equal(h.posts(/:message:/).length, 0);
  assert.equal(h.logs.filter(([level, message]) => level === 'warn' && /message list/.test(message)).length, 1);
});

it('asks again when Devin waits for a second approval with a new message', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'waiting_for_approval' });
  h.devin.say(devin, 'May I run the migration? (private-devin-text)');
  await h.tick();
  devin.status_detail = 'working';
  h.devin.say(devin, 'Migrating (private-devin-text)');
  await h.tick();
  devin.status_detail = 'waiting_for_approval';
  h.devin.say(devin, 'May I push? (private-devin-text)');
  await h.tick();
  await h.tick();
  const elicitations = h.shortcut.activities().filter((a) => a.content.type === 'elicitation');
  assert.deepEqual(elicitations.map((a) => a.key), ['devin-bridge:1:elicitation:evt-1', 'devin-bridge:1:elicitation:evt-3']);
  assert.match(elicitations[1].content.body, /May I push\?/);
  assert.equal(h.posts(/:elicitation:evt-3$/).length, 1, 'the second approval is asked once');
});

it('keys a bare approval and a bare question apart, so a question after an approval still reaches Shortcut', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'waiting_for_approval' });
  await h.tick();
  devin.status_detail = 'working';
  await h.tick();
  devin.status_detail = 'waiting_for_user';
  await h.tick();
  const keys = h.shortcut.activities().filter((a) => a.content.type === 'elicitation').map((a) => a.key);
  assert.deepEqual(keys, ['devin-bridge:1:elicitation:approval', 'devin-bridge:1:elicitation:user']);
  assert.equal(await h.alarmIn(), null, 'the turn is handed back');
});

it('counts the pickup timeout from the send, not from the baseline read', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  h.devin.say(devin, 'Done (private-devin-text)');
  await h.tick();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'More (private-prompt)'))).status, 200);
  for (let i = 0; i < 5; i++) h.devin.failNext(502, {}, /^POST .*\/messages$/);
  while (devin.received.length === 0) await h.tick();
  const sentAt = Date.now();
  for (let i = 0; i < 40 && (await h.alarmIn()) !== null; i++) await h.tick();
  assert.equal(await h.alarmIn(), null);
  assert.ok(Date.now() - sentAt >= 600_000, `ten minutes after the send, not ${Date.now() - sentAt} ms`);
  const [error] = h.shortcut.activities().filter((a) => a.turn === 2 && a.content.type === 'error');
  assert.match(error.content.body, /did not pick up/);
});

it('posts a thought produced after a queued elicitation after it', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  h.shortcut.state.rateLimits.push('120');
  h.devin.say(devin, 'Cloning (private-devin-text)');
  await h.tick();
  devin.status_detail = 'waiting_for_approval';
  h.devin.say(devin, 'May I? (private-devin-text)');
  await h.tick();
  devin.status_detail = 'working';
  h.devin.say(devin, 'Doing it (private-devin-text)');
  await h.tick();
  for (let i = 0; i < 8 && h.shortcut.activities().length < 3; i++) await h.tick();
  assert.deepEqual(h.shortcut.activities().map((a) => a.key), ['devin-bridge:1:ack', 'devin-bridge:1:elicitation:evt-2', 'devin-bridge:1:message:evt-3']);
});

it('keys an elicitation whose Devin message is empty by its kind, so a question after an approval still reaches Shortcut', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'waiting_for_approval' });
  h.devin.say(devin, '');
  await h.tick();
  devin.status_detail = 'working';
  await h.tick();
  devin.status_detail = 'waiting_for_user';
  await h.tick();
  const elicitations = h.shortcut.activities().filter((a) => a.content.type === 'elicitation');
  assert.deepEqual(elicitations.map((a) => a.key), ['devin-bridge:1:elicitation:approval', 'devin-bridge:1:elicitation:user']);
  assert.match(elicitations[1].content.body, /waiting for your input/);
  assert.equal(await h.alarmIn(), null, 'the turn is handed back');
});

it('does not ask an approval again when Devin re-enters waiting without a new message', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'waiting_for_approval' });
  h.devin.say(devin, 'May I run the migration? (private-devin-text)');
  await h.tick();
  await h.tick();
  assert.equal(h.posts(/:elicitation:evt-1$/).length, 1, 'asked once while Devin keeps waiting');
  devin.status_detail = 'working';
  await h.tick();
  devin.status_detail = 'waiting_for_approval';
  await h.tick();
  await h.tick();
  assert.equal(h.posts(/:elicitation:evt-1$/).length, 1, 'a wait on the same message is not written again');
  assert.equal(h.shortcut.activities().filter((a) => a.content.type === 'elicitation').length, 1);
  assert.notEqual(await h.alarmIn(), null, 'still polling');
});

it('sends a retried relay as the text its baseline fixed, and what arrives after the baseline waits for the next relay', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  await h.tick();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Two (private-prompt)'))).status, 200);
  h.devin.state.loseSend = true;
  await h.tick();
  assert.deepEqual(devin.received, ['Two (private-prompt)'], 'the send reached Devin, its answer did not');
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Three (private-prompt)'))).status, 200);
  await h.tick();
  await h.tick();
  assert.deepEqual(devin.received, ['Two (private-prompt)', 'Two (private-prompt)', 'Three (private-prompt)'], 'the retry repeats the fixed text and the later reply follows on its own');
  assertAbout(await h.alarmIn(), 5_000, 'polling');

  const late = setup(t);
  await late.connect();
  const created = late.shortcut.open();
  assert.equal((await late.deliver(late.shortcut.prompt(SID, 'Pick this up (private-prompt)'))).status, 200);
  await late.tick();
  const other = late.devin.only();
  Object.assign(other, { status: 'running', status_detail: 'finished' });
  await late.tick();
  assert.equal((await late.deliver(late.shortcut.prompt(SID, 'Three (private-prompt)'))).status, 200);
  late.devin.state.loseSend = true;
  await late.tick();
  assert.equal((await late.deliver(created)).status, 200);
  await late.tick();
  await late.tick();
  assert.deepEqual(other.received, ['Three (private-prompt)', 'Three (private-prompt)'], 'the context that arrived after the baseline is not in the retry');
  assert.equal((await late.deliver(late.shortcut.prompt(SID, 'Four (private-prompt)'))).status, 200);
  await late.tick();
  assert.equal(other.received.length, 3);
  assert.match(other.received[2], /^Context from Shortcut:\n\nStory 123[^]*Login fails on Safari\.\n\nFour \(private-prompt\)$/);
});

it('drops an older reply that arrives while a newer one is waiting to be resent', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  await h.tick();
  const two = h.shortcut.prompt(SID, 'Two (private-prompt)');
  const three = h.shortcut.prompt(SID, 'Three (private-prompt)');
  assert.equal((await h.deliver(three)).status, 200);
  h.devin.failNext(503, {}, /^POST .*\/messages$/);
  await h.tick();
  assert.deepEqual(devin.received, []);
  assert.equal((await h.deliver(two)).status, 200);
  for (let i = 0; i < 3; i++) await h.tick();
  assert.deepEqual(devin.received, ['Three (private-prompt)'], 'the older reply is superseded once the newer one is sent');
});
