import assert from 'node:assert/strict';
import { it } from 'node:test';
import { SID, assertAbout, setup } from './harness.mjs';

it('stops writing and polling when a write lands on an outdated turn, without terminating Devin', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  const nextTurn = h.shortcut.prompt(SID, 'Change of plan (private-prompt)');
  h.devin.say(devin, 'Working on it (private-devin-text)');
  await h.tick();
  assert.equal(await h.alarmIn(), null);
  assert.equal(h.devinCalls('DELETE').length, 0);
  const before = h.requests.length;
  await h.tick();
  assert.equal(h.requests.length, before, 'nothing more for the outdated turn');

  assert.equal((await h.deliver(nextTurn)).status, 200);
  await h.tick();
  assert.deepEqual(devin.received, ['Change of plan (private-prompt)']);
  assert.ok(h.shortcut.activities().some((a) => a.key === 'devin-bridge:2:ack'));
});

it('honors Retry-After on a rate-limited write, starts Devin meanwhile, and replays the same request later without counting a failure', async (t) => {
  const h = setup(t);
  await h.connect();
  h.shortcut.state.rateLimits.push('30');
  assert.equal((await h.deliver(h.shortcut.open())).status, 200);
  await h.tick();
  assert.equal(h.devin.sessions.length, 1, 'the Devin start does not wait for the Shortcut deadline');
  const devin = h.devin.only();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  await h.tick();
  assertAbout(await h.alarmIn(), 25_000, 'waits for Retry-After');
  h.shortcut.state.serverErrors = 1;
  await h.tick();
  const acks = h.posts(/:ack$/);
  assert.equal(acks.length, 2);
  assert.equal(acks[0].body, acks[1].body, 'the replay is byte-identical');
  assertAbout(await h.alarmIn(), 5_000, 'the first transient failure backs off 5 s, so the 429 was not counted');
  await h.tick();
  assert.deepEqual(h.shortcut.activities().map((a) => a.key), ['devin-bridge:1:ack', 'devin-bridge:1:response']);
  assert.equal(await h.alarmIn(), null);
});

it('keeps the Devin failure budget apart from Shortcut write retries', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  h.devin.say(devin, 'Working (private-devin-text)');
  h.shortcut.state.serverErrors = 7;
  for (let i = 0; i < 7; i++) await h.tick();
  assert.equal(h.posts(/:message:/).length, 7);
  h.devin.failNext(502);
  await h.tick();
  assert.equal(h.shortcut.activities().filter((a) => a.key.includes(':message:')).length, 1);
  assertAbout(await h.alarmIn(), 5_000, 'the first Devin failure backs off 5 s');
  assert.equal(h.shortcut.activities().filter((a) => a.content.type === 'error').length, 0);
  h.shortcut.state.serverErrors = 1;
  h.devin.say(devin, 'Still working (private-devin-text)');
  await h.tick();
  assertAbout(await h.alarmIn(), 5_000, 'the first Shortcut failure after a Devin failure backs off 5 s');
});

it('keeps a Shortcut Retry-After deadline when a new event arrives, relays to Devin meanwhile, and caps it at 10 minutes', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  h.devin.say(devin, 'Done (private-devin-text)');
  h.shortcut.state.rateLimits.push('30');
  await h.tick();
  assertAbout(await h.alarmIn(), 30_000, 'Retry-After');
  const limitedAt = Date.now();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Also Firefox (private-prompt)'))).status, 200);
  assertAbout(await h.alarmIn(), 0, 'a new event wakes the object');
  const writes = () => h.requests.filter((r) => r.origin === 'shortcut' && r.method === 'POST').length;
  const before = writes();
  await h.tick();
  assert.deepEqual(devin.received, ['Also Firefox (private-prompt)'], 'the relay does not wait for the Shortcut deadline');
  assert.equal(writes(), before, 'nothing is written before the deadline');
  while (writes() === before) await h.tick();
  assert.ok(Date.now() - limitedAt >= 30_000, 'the deadline stood');
  assert.equal(h.shortcut.activities().find((a) => a.key === 'devin-bridge:2:ack').turn, 2);

  h.shortcut.state.rateLimits.push('3600');
  h.devin.say(devin, 'More (private-devin-text)');
  await h.tick();
  assertAbout(await h.alarmIn(), 600_000, 'Retry-After is capped');
});

it('honors a Devin 429 with and without Retry-After', async (t) => {
  const h = setup(t);
  await h.connect();
  h.devin.failNext(429, { 'Retry-After': '12' });
  assert.equal((await h.deliver(h.shortcut.open())).status, 200);
  await h.tick();
  assertAbout(await h.alarmIn(), 12_000, 'Devin Retry-After');
  h.devin.failNext(429);
  await h.tick();
  assertAbout(await h.alarmIn(), 60_000, 'default when Devin sends no Retry-After');
  await h.tick();
  assert.equal(h.devin.sessions.length, 1);
});

it('refreshes once when two sessions hit 401 at the same time', async (t) => {
  const h = setup(t);
  await h.connect();
  assert.equal((await h.deliver(h.shortcut.open('sess-1'))).status, 200);
  assert.equal((await h.deliver(h.shortcut.open('sess-2'))).status, 200);
  h.shortcut.state.valid = 'token-2';
  await Promise.all([h.tick('sess-1'), h.tick('sess-2')]);
  assert.equal(h.shortcut.state.refreshes, 1);
  assert.equal(h.shortcut.activities('sess-1').length, 1);
  assert.equal(h.shortcut.activities('sess-2').length, 1);
  h.assertCleanLogs();
});

it('ends the turn once Shortcut rejects the refresh, and serves a reply once the agent is activated again', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  h.shortcut.state.valid = 'revoked';
  h.shortcut.state.refreshFailure = { status: 400, error: 'invalid_grant' };
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  await h.tick();
  assert.equal(h.shortcut.state.refreshes, 1);
  assert.equal(await h.alarmIn(), null);
  await h.tick();
  assert.equal(h.shortcut.state.refreshes, 1, 'an ended turn makes no more calls');
  assert.equal(h.devinCalls('DELETE').length, 0);
  h.assertCleanLogs();

  h.shortcut.state.refreshFailure = null;
  h.shortcut.state.valid = 'token-2';
  await h.connect();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Still there? (private-prompt)'))).status, 200);
  await h.tick();
  assert.deepEqual(devin.received, ['Still there? (private-prompt)']);
  assert.equal(h.devin.sessions.length, 1);
});

it('keeps retrying when the token endpoint fails transiently, then delivers once it recovers', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  h.shortcut.state.valid = 'token-2';
  h.shortcut.state.refreshFailure = { status: 503, error: 'unavailable' };
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  await h.tick();
  assert.ok((await h.alarmIn()) > 0);
  assert.equal(h.shortcut.activities().filter((a) => a.content.type === 'response').length, 0);
  h.shortcut.state.refreshFailure = null;
  await h.tick();
  assert.equal(h.shortcut.activities().filter((a) => a.content.type === 'response').length, 1);
});

it('reports a Devin rejection right away and gives up after repeated transient failures', async (t) => {
  const h = setup(t);
  await h.connect();
  h.devin.failNext(403);
  assert.equal((await h.deliver(h.shortcut.open())).status, 200);
  await h.tick();
  const [rejected] = h.shortcut.activities().filter((a) => a.content.type === 'error');
  assert.match(rejected.content.body, /HTTP 403/);
  assertAbout(await h.alarmIn(), 5_000, 'the tag is looked up again in case the create went out');
  await h.tick();
  await h.tick();
  assert.equal(await h.alarmIn(), null);
  assert.equal(h.devinCalls('DELETE').length, 0);

  const flaky = setup(t);
  const devin = await flaky.started();
  devin.status = 'running';
  const backoff = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000];
  for (const expected of backoff) {
    flaky.devin.failNext(502);
    await flaky.tick();
    assertAbout(await flaky.alarmIn(), expected, 'transient backoff');
  }
  flaky.devin.failNext(502);
  await flaky.tick();
  const [gaveUp] = flaky.shortcut.activities().filter((a) => a.content.type === 'error');
  assert.match(gaveUp.content.body, /could not reach Devin/);
  assert.equal(await flaky.alarmIn(), null);
  flaky.assertCleanLogs();
});

it('retries a write Shortcut answers with 408 or 425', async (t) => {
  for (const status of [408, 425]) {
    const h = setup(t);
    const devin = await h.started();
    Object.assign(devin, { status: 'running', status_detail: 'finished' });
    h.devin.say(devin, 'Done (private-devin-text)');
    h.shortcut.state.rejections.push(status);
    await h.tick();
    assert.ok((await h.alarmIn()) > 0, `${status} is retried`);
    await h.tick();
    assert.equal(h.shortcut.activities().filter((a) => a.content.type === 'response').length, 1, `${status}`);
    assert.equal(await h.alarmIn(), null);
  }
});

it('replaces a rejected outcome once with an error naming the status, and drops a rejected thought', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  h.devin.say(devin, 'Working (private-devin-text)');
  h.shortcut.state.rejections.push(422);
  await h.tick();
  assert.equal(h.shortcut.activities().length, 1, 'a rejected thought is dropped');
  assertAbout(await h.alarmIn(), 5_000, 'polling goes on');
  devin.status_detail = 'finished';
  h.shortcut.state.rejections.push(422);
  await h.tick();
  const [error] = h.shortcut.activities().filter((a) => a.turn === 1 && a.content.type === 'error');
  assert.equal(error.key, 'devin-bridge:1:error:rejected');
  assert.match(error.content.body, /HTTP 422/);
  assert.equal(await h.alarmIn(), null);
  h.assertCleanLogs();

  const twice = setup(t);
  const second = await twice.started();
  Object.assign(second, { status: 'running', status_detail: 'finished' });
  twice.shortcut.state.rejections.push(422, 422);
  await twice.tick();
  assert.deepEqual(twice.shortcut.activities().map((a) => a.key), ['devin-bridge:1:ack']);
  assert.equal(await twice.alarmIn(), null, 'a rejected replacement is dropped');
});

it('keeps a decided outcome through a long Shortcut outage', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  h.devin.say(devin, 'Fixed the login bug. (private-devin-text)');
  h.shortcut.state.serverErrors = 12;
  for (let i = 0; i < 12; i++) {
    await h.tick();
    assert.ok((await h.alarmIn()) > 0, 'still retrying');
  }
  await h.tick();
  const [response] = h.shortcut.activities().filter((a) => a.content.type === 'response');
  assert.match(response.content.body, /Fixed the login bug\./);
  assert.equal(await h.alarmIn(), null);
});

it('stops polling a quiet Devin session once Shortcut rejects the refresh', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  for (let i = 0; i < 5; i++) await h.tick();
  assertAbout(await h.alarmIn(), 60_000, 'quiet at the cap');
  h.shortcut.state.valid = 'revoked';
  h.shortcut.state.refreshFailure = { status: 400, error: 'invalid_grant' };
  await h.tick();
  assert.equal(await h.alarmIn(), null);
  assert.equal(h.shortcut.state.refreshes, 1);
});

it('resets the Shortcut failure count on a successful session read', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  for (let i = 0; i < 5; i++) await h.tick();
  assertAbout(await h.alarmIn(), 60_000, 'quiet at the cap');
  h.shortcut.state.readFailures.push(503);
  await h.tick();
  await h.tick();
  h.shortcut.state.serverErrors = 1;
  h.devin.say(devin, 'Found it (private-devin-text)');
  await h.tick();
  assertAbout(await h.alarmIn(), 5_000, 'the first write failure after a good read backs off 5 s');
});

it('makes one call per alarm when a 429 says to retry at once', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  for (let i = 0; i < 40; i++) h.devin.failNext(429, { 'Retry-After': i % 2 ? '0' : new Date(Date.now() - 1_000).toUTCString() });
  const polls = () => h.devinCalls('GET', /\/sessions\/devin-1$/).length;
  await h.tick();
  assert.equal(polls(), 1, 'one Devin call per alarm');
  assert.equal(await h.alarmIn(), 1_000, 'a zero wait is floored');
  await h.tick();
  assert.equal(polls(), 2);
  assert.equal(h.logs.filter(([, message]) => message === 'Devin Bridge step failed').length, 0);

  const writes = setup(t);
  const other = await writes.started();
  Object.assign(other, { status: 'running', status_detail: 'finished' });
  writes.devin.say(other, 'Done (private-devin-text)');
  for (let i = 0; i < 40; i++) writes.shortcut.state.rateLimits.push('0');
  await writes.tick();
  assert.equal(writes.posts(/:response$/).length, 1, 'one Shortcut write per alarm');
  assert.equal(await writes.alarmIn(), 1_000, 'a zero wait is floored');
});

it('still relays a reply whose ack Shortcut answers with 409, and leaves the next event to decide', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  await h.tick();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'More (private-prompt)'))).status, 200);
  h.shortcut.state.rejections.push(409);
  await h.tick();
  assert.deepEqual(devin.received, ['More (private-prompt)']);
  assert.equal(h.devinCalls('DELETE').length, 0);
  assertAbout(await h.alarmIn(), 5_000, 'polling');
});

it('keeps what the quiet check learned when the Devin poll after it fails', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  for (let i = 0; i < 5; i++) await h.tick();
  assertAbout(await h.alarmIn(), 60_000, 'quiet at the cap');
  h.shortcut.state.readRateLimits.push('600');
  h.devin.failNext(502, {}, /^GET .*\/sessions\/devin-1$/);
  const reads = () => h.requests.filter((r) => r.origin === 'shortcut' && r.method === 'GET' && r.path.endsWith(`/${SID}`)).length;
  await h.tick();
  const read = reads();
  assertAbout(await h.alarmIn(), 5_000, 'the Devin failure backs off');
  await h.tick();
  await h.tick();
  assert.equal(reads(), read, 'the Shortcut deadline the check set stands');
});

it('ends the turn and sends nothing to Devin when Shortcut rejects the refresh while a reply is pending', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  await h.tick();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'More (private-prompt)'))).status, 200);
  h.shortcut.state.valid = 'revoked';
  h.shortcut.state.refreshFailure = { status: 400, error: 'invalid_grant' };
  await h.tick();
  assert.deepEqual(devin.received, [], 'the pending reply is not sent');
  assert.equal(await h.alarmIn(), null, 'polling stops');
  assert.equal(h.shortcut.state.refreshes, 1);
  assert.equal(h.devinCalls('DELETE').length, 0);

  h.shortcut.state.refreshFailure = null;
  h.shortcut.state.valid = 'token-2';
  await h.connect();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Still there? (private-prompt)'))).status, 200);
  await h.tick();
  assert.deepEqual(devin.received, ['Still there? (private-prompt)'], 'the next reply reaches the same Devin session');
  assert.equal(h.devin.sessions.length, 1);
});

it('stops a step whose job sets a deadline that has already passed, and retries it in a minute', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  h.devin.failNext(429, { 'Retry-After': '0' });
  // After the 429 every read of the clock is a second later than the one
  // before, so the floored wait the job sets has passed when it is read back.
  const { handle } = h.devin;
  const clock = Date.now.bind(Date);
  let late = 0;
  h.devin.handle = async (...args) => {
    const response = await handle(...args);
    t.mock.method(Date, 'now', () => clock() + (late += 1_000));
    return response;
  };
  await h.tick();
  Date.now.mock.restore();
  assert.equal(h.devinCalls('GET', /\/sessions\/devin-1$/).length, 1, 'one Devin call');
  assert.deepEqual(h.logs.filter(([, message]) => message === 'Devin Bridge step failed').map(([, , detail]) => detail), [{ error: 'StalledError', sessionId: SID }]);
  assertAbout(await h.alarmIn(), 60_000 + late, 'retry in a minute');
});

it('does not mistake storage latency after a floored wait for a stalled step', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  h.devin.failNext(429, { 'Retry-After': '0' });
  const storage = h.env.SESSIONS.storages.get(SID);
  const put = storage.put;
  storage.put = async (...args) => {
    t.mock.timers.tick(1_000);
    return put.apply(storage, args);
  };
  await h.tick();
  storage.put = put;
  const polls = () => h.devinCalls('GET', /\/sessions\/devin-1$/).length;
  assert.equal(polls(), 1);
  assert.equal(h.logs.filter(([, message]) => message === 'Devin Bridge step failed').length, 0);
  assert.equal(await h.alarmIn(), 0, 'the wait passed during the save, so the poll is due again');
  await h.tick();
  assert.equal(polls(), 2);
});

it('ends the turn when Shortcut rejects the refresh on the card link, and the next reply reaches the same Devin session', async (t) => {
  const h = setup(t);
  await h.connect();
  const { handle } = h.shortcut;
  h.shortcut.handle = async (url, init) => {
    const response = await handle(url, init);
    if (url.pathname.endsWith('/activities')) Object.assign(h.shortcut.state, { valid: 'revoked', refreshFailure: { status: 400, error: 'invalid_grant' } });
    return response;
  };
  assert.equal((await h.deliver(h.shortcut.open())).status, 200);
  await h.tick();
  const devin = h.devin.only();
  assert.equal(h.shortcut.state.refreshes, 1);
  assert.deepEqual(h.shortcut.sessions.get(SID).external_urls, []);
  assert.equal(await h.alarmIn(), null, 'the turn is over');
  assert.equal(h.devinCalls('GET', /\/sessions\/devin-1$/).length, 0, 'Devin is not polled for a turn Shortcut cannot see');
  assert.equal(devin.terminated, undefined);
  h.assertCleanLogs();

  h.shortcut.handle = handle;
  h.shortcut.state.refreshFailure = null;
  h.shortcut.state.valid = 'token-2';
  await h.connect();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Still there? (private-prompt)'))).status, 200);
  await h.tick();
  assert.deepEqual(devin.received, ['Still there? (private-prompt)']);
  assert.equal(h.devin.sessions.length, 1);
});

it('drops a reply whose ack Shortcut answers with 409 when Shortcut ended the turn itself', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  await h.tick();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'More (private-prompt)'))).status, 200);
  h.shortcut.failTurn(SID);
  await h.tick();
  assert.deepEqual(devin.received, [], 'nothing reaches Devin that Shortcut cannot see');
  assert.equal(await h.alarmIn(), null);
  assert.equal(h.devinCalls('DELETE').length, 0, 'the Devin session is kept');
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Again (private-prompt)'))).status, 200);
  await h.tick();
  assert.deepEqual(devin.received, ['Again (private-prompt)']);
  assert.equal(h.devin.sessions.length, 1);
});

it('drops a reply whose ack gets a 409 when the session read that follows fails', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  await h.tick();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Do more work (private-prompt)'))).status, 200);
  h.shortcut.failTurn(SID);
  h.shortcut.state.readFailures.push(503);
  for (let i = 0; i < 3; i++) await h.tick();
  assert.deepEqual(devin.received, [], 'a turn Shortcut may have ended gets nothing');
  assert.equal(h.devinCalls('DELETE').length, 0, 'the Devin session is kept');
});

it('keeps the late context for the next reply when a relay carrying it fails', async (t) => {
  const h = setup(t);
  await h.connect();
  const created = h.shortcut.open();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Pick this up (private-prompt)'))).status, 200);
  await h.tick();
  const devin = h.devin.only();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  await h.tick();
  assert.equal((await h.deliver(created)).status, 200);
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Three (private-prompt)'))).status, 200);
  h.devin.failNext(401, {}, /^POST .*\/messages$/);
  await h.tick();
  assert.deepEqual(devin.received, []);
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Retry request (private-prompt)'))).status, 200);
  await h.tick();
  assert.equal(devin.received.length, 1);
  assert.match(devin.received[0], /Context from Shortcut[\s\S]*Retry request/);
});
