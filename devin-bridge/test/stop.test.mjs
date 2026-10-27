import assert from 'node:assert/strict';
import { it } from 'node:test';
import { SID, assertAbout, setup } from './harness.mjs';

it('stops: terminates Devin, answers on the same turn, and a later prompt starts a new Devin session', async (t) => {
  const h = setup(t);
  const first = await h.started();
  Object.assign(first, { status: 'running', status_detail: 'working' });
  h.devin.say(first, 'Still working (private-devin-text)');
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  await h.tick();

  assert.equal(first.terminated, true);
  const activities = h.shortcut.activities();
  const stopped = activities.find((a) => a.key === 'devin-bridge:1:stopped');
  assert.equal(stopped.content.type, 'response');
  assert.equal(stopped.turn, 1);
  assert.ok(stopped.content.body.includes(first.url));
  assert.ok(activities.slice(activities.indexOf(stopped)).every((a) => a.content.type !== 'thought'));
  assert.equal(h.posts(/:message:/).length, 0, 'no progress is posted after a stop');
  assert.equal(await h.alarmIn(), null);

  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Try again with Chrome (private-prompt)'))).status, 200);
  await h.tick();
  assert.equal(h.devin.sessions.length, 2);
  const second = h.devin.sessions[1];
  assert.deepEqual(second.tags, ['shortcut-session-sess-1-2']);
  assert.match(second.prompt, /Try again with Chrome/);
  assert.match(second.prompt, /Login fails on Safari\./);
  assert.deepEqual(h.shortcut.sessions.get(SID).external_urls, [{ label: 'Open in Devin', url: second.url }]);
  assert.equal(h.shortcut.activities().find((a) => a.key === 'devin-bridge:2:ack').turn, 2);

  const queued = setup(t);
  await queued.connect();
  queued.shortcut.state.rateLimits.push('1');
  assert.equal((await queued.deliver(queued.shortcut.open())).status, 200);
  await queued.tick();
  assert.equal((await queued.deliver(queued.shortcut.stop(SID))).status, 200);
  await queued.tick();
  await queued.tick();
  assert.equal(queued.posts(/:ack$/).length, 1, 'a thought still queued at the stop is dropped, not retried');
  assert.deepEqual(queued.shortcut.activities().map((a) => [a.key, a.content.type]), [['devin-bridge:1:stopped', 'response']]);
  assert.equal(queued.devin.only().terminated, true, 'the start did not wait for the ack');
});

it('a stop before the Devin session is known terminates the one created under its tag, and the next reply starts a new one', async (t) => {
  const h = setup(t);
  await h.connect();
  h.devin.state.loseCreate = true;
  assert.equal((await h.deliver(h.shortcut.open())).status, 200);
  await h.tick();
  const first = h.devin.only();
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  await h.tick();
  await h.tick();
  assert.equal(first.terminated, true);
  const stopped = h.shortcut.activities().find((a) => a.key === 'devin-bridge:1:stopped');
  assert.ok(stopped.content.body.includes(first.url));
  assert.equal(await h.alarmIn(), null);
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Try again (private-prompt)'))).status, 200);
  await h.tick();
  assert.equal(h.devin.sessions.length, 2);
  assert.deepEqual(h.devin.sessions[1].tags, ['shortcut-session-sess-1-2']);
});

it('a stop on a turn the bridge never saw answers on that turn', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  h.shortcut.prompt(SID, 'Lost in delivery (private-prompt)');
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  await h.tick();
  assert.equal(devin.terminated, true);
  const stopped = h.shortcut.activities().find((a) => a.key === 'devin-bridge:2:stopped');
  assert.equal(stopped.turn, 2);
  assert.equal(await h.alarmIn(), null);
});

it('a prompt over a pending stop terminates Devin first, even while Shortcut is down, then starts a new session on the new turn', async (t) => {
  const h = setup(t);
  const first = await h.started();
  Object.assign(first, { status: 'running', status_detail: 'working' });
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Try Chrome instead (private-prompt)'))).status, 200);
  h.shortcut.state.serverErrors = 1;
  await h.tick();
  assert.equal(first.terminated, true);
  assert.equal(h.devin.sessions.length, 2, 'the new session does not wait for the ack');
  assert.deepEqual(first.received, []);
  assert.match(h.devin.sessions[1].prompt, /Try Chrome instead/);
  assert.deepEqual(h.devin.sessions[1].tags, ['shortcut-session-sess-1-2']);
  assert.deepEqual(h.shortcut.activities().map((a) => [a.key, a.content.type]), [['devin-bridge:1:ack', 'thought']]);
  assertAbout(await h.alarmIn(), 5_000, 'the ack retries and the poll is due together');
  await h.tick();
  assert.deepEqual(h.shortcut.activities().map((a) => [a.key, a.content.type]), [['devin-bridge:1:ack', 'thought'], ['devin-bridge:2:ack', 'thought']]);
});

it('does not terminate Devin twice when the step dies after posting the stop', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  const storage = h.env.SESSIONS.storages.get(SID);
  const put = storage.put;
  storage.put = async (...args) => {
    if (h.posts(/:stopped$/).length === 0) return put.apply(storage, args);
    storage.put = put;
    throw new Error('evicted');
  };
  await h.tick();
  assert.equal(storage.put, put, 'the step died at its put after the post');
  assertAbout(await h.alarmIn(), 60_000, 'retry after a failed step');
  const failed = h.logs.find(([, message]) => message === 'Devin Bridge step failed');
  assert.deepEqual(failed[2], { error: 'Error', sessionId: SID });
  assert.doesNotMatch(JSON.stringify(h.logs), /evicted/);
  await h.tick();
  assert.equal(h.devinCalls('DELETE').length, 1);
  assert.deepEqual(h.shortcut.activities().map((a) => a.key), ['devin-bridge:1:ack', 'devin-bridge:1:stopped']);
  assert.equal(await h.alarmIn(), null);
});

it('stops quietly when Shortcut ended the turn itself, and ignores a closed session afterwards', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  h.shortcut.failTurn(SID);
  h.devin.say(devin, 'Working (private-devin-text)');
  await h.tick();
  assert.equal(await h.alarmIn(), null);
  assert.equal(h.shortcut.activities().filter((a) => a.content.type === 'error').length, 0);
  assert.equal(h.devinCalls('DELETE').length, 0);

  const closed = setup(t);
  const other = await closed.started();
  Object.assign(other, { status: 'running', status_detail: 'working' });
  const later = closed.shortcut.prompt(SID, 'Anyone there? (private-prompt)');
  closed.shortcut.sessions.get(SID).closed = true;
  closed.devin.say(other, 'Working (private-devin-text)');
  await closed.tick();
  assert.equal(await closed.alarmIn(), null);
  assert.equal((await closed.deliver(later)).status, 200);
  await closed.tick();
  assert.deepEqual(other.received, []);
  assert.equal(await closed.alarmIn(), null);
});

it('terminates the Devin session when Shortcut says the session is gone or the workspace leaves the allowlist', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  h.devin.say(devin, 'Working (private-devin-text)');
  h.shortcut.sessions.get(SID).closed = true;
  await h.tick();
  assert.equal(devin.terminated, true);
  assert.equal(await h.alarmIn(), null);
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Anyone? (private-prompt)'))).status, 200);
  await h.tick();
  assert.equal(h.devinCalls('DELETE').length, 1);
  assert.equal(h.devin.sessions.length, 1);

  const removed = setup(t);
  const other = await removed.started();
  Object.assign(other, { status: 'running', status_detail: 'working' });
  removed.env.ALLOWED_WORKSPACE_IDS = 'other-workspace';
  await removed.tick();
  assert.equal(other.terminated, true);
  assert.equal(await removed.alarmIn(), null);
});

it('honors a stop that arrives while an elicitation is still queued', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'waiting_for_user' });
  h.devin.say(devin, 'Which branch should I use? (private-devin-text)');
  h.shortcut.state.rateLimits.push('30');
  await h.tick();
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  await h.tick();
  await h.tick();
  assert.equal(h.devinCalls('DELETE').length, 1);
  assert.deepEqual(h.shortcut.activities().map((a) => [a.key, a.content.type]), [['devin-bridge:1:ack', 'thought'], ['devin-bridge:1:stopped', 'response']]);
  assert.equal(await h.alarmIn(), null);
});

it('ends the turn quietly when Shortcut reports the session stale', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  for (let i = 0; i < 5; i++) await h.tick();
  h.shortcut.sessions.get(SID).status = 'stale';
  await h.tick();
  assert.equal(await h.alarmIn(), null);
  assert.equal(h.devinCalls('DELETE').length, 0);
  assert.equal(h.shortcut.activities().filter((a) => a.content.type === 'error').length, 0);
});

it('stops polling a quiet Devin session once Shortcut has ended the turn on its own', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  for (let i = 0; i < 5; i++) await h.tick();
  assertAbout(await h.alarmIn(), 60_000, 'quiet at the cap');
  await h.tick();
  assertAbout(await h.alarmIn(), 60_000, 'an open turn keeps polling');
  h.shortcut.failTurn(SID);
  await h.tick();
  assert.equal(await h.alarmIn(), null);
  assert.equal(h.devinCalls('DELETE').length, 0);
  assert.equal(h.shortcut.activities().filter((a) => a.content.type === 'error').length, 0);
});

it('a stop during a new generation\'s unresolved start terminates the session under its tag, not the one already given up', async (t) => {
  const h = setup(t);
  const first = await h.started();
  Object.assign(first, { status: 'running', status_detail: 'finished' });
  await h.tick();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'More (private-prompt)'))).status, 200);
  h.devin.failNext(400);
  await h.tick();
  h.devin.state.loseCreate = true;
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Again (private-prompt)'))).status, 200);
  await h.tick();
  const second = h.devin.sessions[1];
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  await h.tick();
  await h.tick();
  assert.equal(second.terminated, true);
  const stopped = h.shortcut.activities().find((a) => a.key === 'devin-bridge:3:stopped');
  assert.ok(stopped.content.body.includes(second.url));
  assert.ok(!stopped.content.body.includes(first.url));
  assert.equal(await h.alarmIn(), null);
});

it('closing a session whose start is unresolved terminates the Devin session created under its tag', async (t) => {
  const h = setup(t);
  await h.connect();
  h.devin.state.loseCreate = true;
  assert.equal((await h.deliver(h.shortcut.open())).status, 200);
  await h.tick();
  const devin = h.devin.only();
  h.env.ALLOWED_WORKSPACE_IDS = 'other-workspace';
  await h.tick();
  assert.equal(devin.terminated, true);
  assert.equal(await h.alarmIn(), null);
});

it('finishes a stop whose terminate Devin refuses, and retires the session when Devin is unreachable', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  h.devin.failNext(409, {}, /^DELETE /);
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  await h.tick();
  assert.deepEqual(h.shortcut.activities().map((a) => [a.key, a.content.type]), [['devin-bridge:1:ack', 'thought'], ['devin-bridge:1:stopped', 'response']]);
  assert.equal(await h.alarmIn(), null);

  const down = setup(t);
  const first = await down.started();
  Object.assign(first, { status: 'running', status_detail: 'working' });
  assert.equal((await down.deliver(down.shortcut.stop(SID))).status, 200);
  assert.equal((await down.deliver(down.shortcut.prompt(SID, 'Try Chrome (private-prompt)'))).status, 200);
  for (let i = 0; i < 8; i++) {
    down.devin.failNext(502, {}, /^DELETE /);
    await down.tick();
  }
  assert.equal(down.devin.sessions.length, 2, 'the stop finished and the prompt after it started a new session');
  assert.match(down.devin.sessions[1].prompt, /Try Chrome/);
  assert.equal(first.terminated, true, 'the stopped session is terminated once Devin answers');
  assert.equal(down.shortcut.activities().filter((a) => a.content.type === 'error').length, 0);
  down.assertCleanLogs();
});

it('a Shortcut backoff does not delay a stop, and a Shortcut rate limit on the quiet read holds the read but not the poll', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  h.devin.say(devin, 'Working (private-devin-text)');
  h.shortcut.state.serverErrors = 1;
  await h.tick();
  assertAbout(await h.alarmIn(), 5_000, 'Shortcut backoff');
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  await h.tick();
  assert.equal(devin.terminated, true, 'the stop does not wait for Shortcut');
  await h.tick();
  assert.ok(h.shortcut.activities().some((a) => a.key === 'devin-bridge:1:stopped'));

  const quiet = setup(t);
  const other = await quiet.started();
  Object.assign(other, { status: 'running', status_detail: 'working' });
  for (let i = 0; i < 5; i++) await quiet.tick();
  assertAbout(await quiet.alarmIn(), 60_000, 'quiet at the cap');
  quiet.shortcut.state.readRateLimits.push('30');
  const polls = () => quiet.devinCalls('GET', /\/sessions\/devin-1$/).length;
  const reads = () => quiet.requests.filter((r) => r.origin === 'shortcut' && r.method === 'GET' && r.path.endsWith(`/${SID}`)).length;
  const [polled, read] = [polls(), reads()];
  await quiet.tick();
  assert.equal(polls(), polled + 1, 'Devin is still polled');
  assert.equal(reads(), read + 1);
  assertAbout(await quiet.alarmIn(), 60_000, 'the quiet poll keeps its pace');
  await quiet.tick();
  assert.equal(reads(), read + 2, 'the read resumes once Retry-After has passed');
  assert.equal(polls(), polled + 2);
});

it('answers a stop Devin refuses to terminate without claiming termination, then retirement finishes the job or gives up', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  h.devin.failNext(403, {}, /^DELETE /);
  h.devin.failNext(403, {}, /^DELETE /);
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  await h.tick();
  const stopped = h.shortcut.activities().find((a) => a.key === 'devin-bridge:1:stopped');
  assert.equal(stopped.content.body, 'Stopped.');
  assert.equal(devin.terminated, undefined);
  assertAbout(await h.alarmIn(), 5_000, 'retirement retries');
  await h.tick();
  assert.equal(devin.terminated, true);
  assert.equal(await h.alarmIn(), null);

  const refused = setup(t);
  const other = await refused.started();
  Object.assign(other, { status: 'running', status_detail: 'working' });
  for (let i = 0; i < 9; i++) refused.devin.failNext(401, {}, /^DELETE /);
  assert.equal((await refused.deliver(refused.shortcut.stop(SID))).status, 200);
  for (let i = 0; i < 8; i++) await refused.tick();
  assert.equal(refused.devinCalls('DELETE').length, 9);
  assert.equal(await refused.alarmIn(), null);
  assert.equal(refused.logs.filter(([level, message]) => level === 'warn' && /gave up terminating/.test(message)).length, 1);
  refused.assertCleanLogs();
});

it('a stop delivered after the reply that followed it still terminates Devin first, and a stop for a reply already sent is ignored', async (t) => {
  const h = setup(t);
  const first = await h.started();
  Object.assign(first, { status: 'running', status_detail: 'working' });
  const stop = h.shortcut.stop(SID);
  const reply = h.shortcut.prompt(SID, 'Try Chrome (private-prompt)');
  assert.equal((await h.deliver(reply)).status, 200);
  assert.equal((await h.deliver(stop)).status, 200);
  await h.tick();
  assert.equal(first.terminated, true);
  assert.deepEqual(first.received, []);
  assert.equal(h.devin.sessions.length, 2);
  assert.match(h.devin.sessions[1].prompt, /Try Chrome/);
  assert.deepEqual(h.shortcut.activities().map((a) => [a.key, a.content.type]), [['devin-bridge:1:ack', 'thought'], ['devin-bridge:2:ack:restart', 'thought']]);

  const sent = setup(t);
  const devin = await sent.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  const stale = sent.shortcut.stop(SID);
  assert.equal((await sent.deliver(sent.shortcut.prompt(SID, 'More (private-prompt)'))).status, 200);
  await sent.tick();
  assert.deepEqual(devin.received, ['More (private-prompt)']);
  assert.equal((await sent.deliver(stale)).status, 200);
  await sent.tick();
  assert.equal(sent.devinCalls('DELETE').length, 0, 'a stop for a turn whose reply was sent is ignored');
  assert.equal(sent.devin.sessions.length, 1);
  assertAbout(await sent.alarmIn(), 5_000, 'polling goes on');
});

it('a stop of an unresolved tag terminates every match, and a tag that finds nothing is looked up twice more before it is dropped', async (t) => {
  const h = setup(t);
  await h.connect();
  const a = h.devin.seed({ tags: ['shortcut-session-sess-1-1'] });
  const b = h.devin.seed({ tags: ['shortcut-session-sess-1-1'] });
  h.devin.failNext(502, {}, /^GET .*\/sessions$/);
  assert.equal((await h.deliver(h.shortcut.open())).status, 200);
  await h.tick();
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  await h.tick();
  await h.tick();
  assert.equal(a.terminated, true);
  assert.equal(b.terminated, true);
  assert.equal(await h.alarmIn(), null);

  for (const found of [true, false]) {
    const lag = setup(t);
    await lag.connect();
    lag.devin.failNext(502, {}, /^GET .*\/sessions$/);
    assert.equal((await lag.deliver(lag.shortcut.open())).status, 200);
    await lag.tick();
    assert.equal((await lag.deliver(lag.shortcut.stop(SID))).status, 200);
    await lag.tick();
    await lag.tick();
    const lookups = () => lag.devinCalls('GET', /\/sessions$/).length;
    assert.equal(lookups(), 2);
    assert.equal(lag.shortcut.activities().find((a) => a.key === 'devin-bridge:1:stopped').content.body, 'Stopped.');
    assertAbout(await lag.alarmIn(), 5_000, 'the tag is looked up again');
    await lag.tick();
    assert.equal(lookups(), 3);
    assertAbout(await lag.alarmIn(), 10_000, 'and once more');
    const late = found ? lag.devin.seed({ tags: ['shortcut-session-sess-1-1'] }) : null;
    await lag.tick();
    assert.equal(lookups(), 4);
    assert.equal(late?.terminated, found ? true : undefined);
    assert.equal(await lag.alarmIn(), null);
    assert.equal(lag.logs.filter(([level]) => level === 'warn').length, 0);
  }
});

it('terminates Devin for a stop before the workspace credentials are loaded', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  const workspace = h.env.WORKSPACES.get('workspace');
  let releaseCredentials;
  const credentials = new Promise((resolve) => { releaseCredentials = resolve; });
  const fetch = workspace.fetch.bind(workspace);
  workspace.fetch = async (request) => { await credentials; return fetch(request); };
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  const { release, reached } = h.devin.hold();
  const stepping = h.tick();
  await Promise.race([reached, new Promise((resolve) => setTimeout(resolve, 200)).then(() => assert.fail('the stop waited for the credentials'))]);
  assert.equal(h.devinCalls('DELETE').length, 1);
  release();
  releaseCredentials();
  await stepping;
  assert.equal(devin.terminated, true);
  assert.ok(h.shortcut.activities().some((a) => a.key === 'devin-bridge:1:stopped'));
});

it('retirement keeps its own deadline, so it neither waits on Shortcut nor holds the poll, while a Devin 429 holds both', async (t) => {
  const h = setup(t);
  const first = await h.started();
  Object.assign(first, { status: 'running', status_detail: 'finished' });
  await h.tick();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'More (private-prompt)'))).status, 200);
  h.devin.failNext(400, {}, /^GET /);
  h.devin.failNext(502, {}, /^DELETE /);
  h.shortcut.state.rateLimits.push('600');
  await h.tick();
  assertAbout(await h.alarmIn(), 5_000, 'retirement retries on its own deadline during a Shortcut wait');
  await h.tick();
  assert.equal(first.terminated, true);
  assertAbout(await h.alarmIn(), 595_000, 'the outcome waits for Shortcut');

  const polling = setup(t);
  const given = await polling.started();
  Object.assign(given, { status: 'running', status_detail: 'finished' });
  await polling.tick();
  assert.equal((await polling.deliver(polling.shortcut.prompt(SID, 'More (private-prompt)'))).status, 200);
  polling.devin.failNext(400, {}, /^GET /);
  polling.devin.failNext(502, {}, /^DELETE /);
  await polling.tick();
  assert.equal((await polling.deliver(polling.shortcut.prompt(SID, 'Again (private-prompt)'))).status, 200);
  await polling.tick();
  const second = polling.devin.sessions[1];
  Object.assign(second, { status: 'running', status_detail: 'working' });
  polling.devin.say(second, 'Cloning (private-devin-text)');
  polling.devin.failNext(502, {}, /^DELETE /);
  await polling.tick();
  assertAbout(await polling.alarmIn(), 5_000, 'the poll is not held by the retire backoff');
  const polls = () => polling.devinCalls('GET', /\/sessions\/devin-2$/).length;
  const before = polls();
  polling.devin.failNext(429, { 'Retry-After': '30' }, /^DELETE /);
  await polling.tick();
  assert.equal(polls(), before + 1);
  assert.equal(given.terminated, undefined);
  assertAbout(await polling.alarmIn(), 5_000, 'retirement is next');
  await polling.tick();
  assertAbout(await polling.alarmIn(), 30_000, 'a Devin 429 holds the poll too');
  await polling.tick();
  assert.equal(given.terminated, true);
  assert.equal(polls(), before + 2);
});

it('acknowledges a stale stop under its own key once the reply\'s ack is posted', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  await h.tick();
  const stop = h.shortcut.stop(SID);
  const reply = h.shortcut.prompt(SID, 'More (private-prompt)');
  h.devin.failNext(429, { 'Retry-After': '30' }, /^GET /);
  assert.equal((await h.deliver(reply)).status, 200);
  await h.tick();
  assert.ok(h.shortcut.activities().some((a) => a.key === 'devin-bridge:2:ack'));
  assert.deepEqual(devin.received, []);
  assert.equal((await h.deliver(stop)).status, 200);
  await h.tick();
  await h.tick();
  assert.equal(devin.terminated, true);
  assert.equal(h.devin.sessions.length, 2, 'the reply starts a new session');
  assert.match(h.devin.sessions[1].prompt, /More/);
  assert.deepEqual(h.shortcut.activities().filter((a) => a.turn === 2).map((a) => a.key), ['devin-bridge:2:ack', 'devin-bridge:2:ack:restart']);
});

it('a stale stop cancels the replies up to its turn, keeps the later ones for the new session, and an older reply cannot bring them back', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  await h.tick();
  const two = h.shortcut.prompt(SID, 'Two (private-prompt)');
  const stop = h.shortcut.stop(SID);
  const three = h.shortcut.prompt(SID, 'Three (private-prompt)');
  assert.equal((await h.deliver(three)).status, 200);
  assert.equal((await h.deliver(two)).status, 200);
  assert.equal((await h.deliver(stop)).status, 200);
  h.devin.failNext(502, {}, /^POST .*\/sessions$/);
  await h.tick();
  assert.equal(devin.terminated, true);
  assert.deepEqual(devin.received, []);
  assertAbout(await h.alarmIn(), 5_000, 'the create is retried');
  assert.equal((await h.deliver({ ...two, id: 'event-two-again' })).status, 200, 'the cancelled reply is delivered again under a new id');
  await h.tick();
  await h.tick();
  assert.equal(h.devin.sessions.length, 2);
  const second = h.devin.sessions[1];
  assert.match(second.prompt, /Three/);
  assert.doesNotMatch(second.prompt, /Two/, 'a reply the stop cancelled stays cancelled');
  assert.deepEqual(second.received, []);
  assert.ok(h.shortcut.activities().some((a) => a.key === 'devin-bridge:3:ack:restart'));
});

it('a stale stop during an attempted start terminates the session under its tag and starts a new one with the replies after the stop', async (t) => {
  const h = setup(t);
  await h.connect();
  h.devin.state.loseCreate = true;
  assert.equal((await h.deliver(h.shortcut.open())).status, 200);
  await h.tick();
  const first = h.devin.only();
  const stop = h.shortcut.stop(SID);
  const reply = h.shortcut.prompt(SID, 'Try Chrome (private-prompt)');
  assert.equal((await h.deliver(reply)).status, 200);
  assert.equal((await h.deliver(stop)).status, 200);
  await h.tick();
  await h.tick();
  assert.equal(first.terminated, true);
  assert.deepEqual(first.received, [], 'the reply after the stop does not go to the stopped session');
  assert.equal(h.devin.sessions.length, 2);
  assert.match(h.devin.sessions[1].prompt, /Try Chrome/);
  assert.deepEqual(h.devin.sessions[1].tags, ['shortcut-session-sess-1-2']);
  assert.ok(h.shortcut.activities().some((a) => a.key === 'devin-bridge:2:ack:restart'));
});

it('a stale stop the bridge ignores still cancels its replies when they arrive later', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  await h.tick();
  const two = h.shortcut.prompt(SID, 'Two (private-prompt)');
  const stop = h.shortcut.stop(SID);
  const three = h.shortcut.prompt(SID, 'Three (private-prompt)');
  const four = h.shortcut.prompt(SID, 'Four (private-prompt)');
  assert.equal((await h.deliver(three)).status, 200);
  h.devin.failNext(400);
  await h.tick();
  assert.equal(devin.terminated, true, 'Devin rejected the relay, so the session was given up');
  assert.equal((await h.deliver(stop)).status, 200);
  await h.tick();
  assert.equal(h.devinCalls('DELETE').length, 1, 'the stale stop has nothing to terminate');
  assert.equal((await h.deliver(four)).status, 200);
  assert.equal((await h.deliver(two)).status, 200);
  await h.tick();
  assert.equal(h.devin.sessions.length, 2);
  assert.match(h.devin.sessions[1].prompt, /Four/);
  assert.doesNotMatch(h.devin.sessions[1].prompt, /Two/, 'the reply the stop cancelled stays cancelled');
});

it('drops an older reply once a newer one was sent to Devin', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  await h.tick();
  const two = h.shortcut.prompt(SID, 'Two (private-prompt)');
  const three = h.shortcut.prompt(SID, 'Three (private-prompt)');
  const four = h.shortcut.prompt(SID, 'Four (private-prompt)');
  assert.equal((await h.deliver(three)).status, 200);
  await h.tick();
  assert.deepEqual(devin.received, ['Three (private-prompt)']);
  assert.equal((await h.deliver(four)).status, 200);
  assert.equal((await h.deliver(two)).status, 200);
  await h.tick();
  assert.deepEqual(devin.received, ['Three (private-prompt)', 'Four (private-prompt)'], 'the reply a sent one superseded is dropped');
});

it('a stale stop cancels the replies waiting on a pending stop up to its turn', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  const two = h.shortcut.prompt(SID, 'Two (private-prompt)');
  const stopTwo = h.shortcut.stop(SID);
  const three = h.shortcut.prompt(SID, 'Three (private-prompt)');
  const stopThree = h.shortcut.stop(SID);
  const four = h.shortcut.prompt(SID, 'Four (private-prompt)');
  for (const event of [two, stopTwo, three, four, stopThree]) assert.equal((await h.deliver(event)).status, 200);
  await h.tick();
  assert.equal(devin.terminated, true);
  assert.deepEqual(devin.received, []);
  assert.equal(h.devin.sessions.length, 2);
  const second = h.devin.sessions[1];
  assert.match(second.prompt, /Four/);
  assert.doesNotMatch(second.prompt, /Three/, 'the reply the later stop cancelled does not open the new session');
  assert.equal((await h.deliver({ ...three, id: 'event-three-again' })).status, 200);
  await h.tick();
  assert.deepEqual(second.received, [], 'a cancelled reply delivered again stays cancelled');
  assert.equal(h.devin.sessions.length, 2);
});
