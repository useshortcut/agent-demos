import assert from 'node:assert/strict';
import { it } from 'node:test';
import { SID, assertAbout, setup } from './harness.mjs';

it('acknowledges a new session, starts Devin with the context, links it, and polls in about 5 seconds', async (t) => {
  const h = setup(t);
  await h.connect();
  const event = h.shortcut.open(SID, { external_urls: [{ label: 'Docs', url: 'https://docs.example/login' }], version: 3 });
  assert.equal((await h.deliver(event)).status, 200);
  await h.tick();

  const [ack] = h.shortcut.activities();
  assert.equal(ack.key, 'devin-bridge:1:ack');
  assert.equal(ack.content.type, 'thought');
  assert.equal(ack.ephemeral, true);
  assert.equal(ack.turn, 1);
  const ackAt = h.requests.findIndex((r) => r.method === 'POST' && r.path.endsWith('/activities'));
  const createAt = h.requests.findIndex((r) => r.origin === 'devin' && r.method === 'POST' && r.path.endsWith('/sessions'));
  assert.ok(ackAt >= 0 && ackAt < createAt, 'the ack is posted before the slow Devin create');

  const devin = h.devin.only();
  assert.match(devin.prompt, /Please fix the Safari login bug/);
  assert.match(devin.prompt, /Login fails on Safari\./);
  assert.match(devin.prompt, /https:\/\/app\.shortcut\.com\/acme\/story\/123/);
  assert.deepEqual(devin.tags, ['shortcut-session-sess-1-1']);

  const patch = h.requests.find((r) => r.method === 'PATCH');
  assert.equal(JSON.parse(patch.body).version, 3);
  assert.deepEqual(h.shortcut.sessions.get(SID).external_urls, [
    { label: 'Docs', url: 'https://docs.example/login' },
    { label: 'Open in Devin', url: devin.url },
  ]);
  assertAbout(await h.alarmIn(), 5_000, 'first poll');
  h.assertCleanLogs();
});

it('relays a reply merged into an unresolved start once the tagged Devin session is adopted', async (t) => {
  const h = setup(t);
  await h.connect();
  h.devin.state.loseCreate = true;
  assert.equal((await h.deliver(h.shortcut.open())).status, 200);
  await h.tick();
  const devin = h.devin.only();
  assertAbout(await h.alarmIn(), 5_000, 'retry after the lost create response');
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox (private-prompt)'))).status, 200);
  await h.tick();
  await h.tick();
  assert.equal(h.devin.sessions.length, 1);
  assert.deepEqual(devin.received, ['Also fix Firefox (private-prompt)']);
  assert.equal(h.shortcut.activities().find((a) => a.key === 'devin-bridge:2:ack').turn, 2);
  assertAbout(await h.alarmIn(), 5_000, 'polling after the relay');
  h.assertCleanLogs();
});

it('starts Devin from a reply to a session it never saw, which carries no prompt context', async (t) => {
  const h = setup(t);
  await h.connect();
  h.shortcut.open();
  const reply = h.shortcut.prompt(SID, 'Pick this up (private-prompt)');
  assert.equal('prompt_context' in reply, false);
  assert.equal((await h.deliver(reply)).status, 200);
  await h.tick();

  const devin = h.devin.only();
  assert.match(devin.prompt, /Pick this up/);
  assert.match(devin.prompt, /https:\/\/app\.shortcut\.com\/acme\/story\/123/);
  assert.doesNotMatch(devin.prompt, /Context from Shortcut/);
  assert.equal(h.posts(/:ack$/).length, 1);
});

it('ignores a reply whose content is not text, and starts from a created event without any', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  await h.tick();
  const attachment = { type: 'attachment', url: 'https://files.example/private-file.png' };
  assert.equal((await h.deliver(h.shortcut.prompt(SID, attachment))).status, 200);
  await h.tick();
  assert.deepEqual(devin.received, []);
  assert.equal(h.devin.sessions.length, 1);
  assert.equal(h.shortcut.activities().filter((a) => a.turn === 2).length, 0);
  assert.equal(await h.alarmIn(), null);

  const bare = setup(t);
  await bare.connect();
  assert.equal((await bare.deliver(bare.shortcut.open(SID, { body: attachment }))).status, 200);
  await bare.tick();
  assert.match(bare.devin.only().prompt, /^Work on this Shortcut story\./);
  assert.doesNotMatch(bare.devin.only().prompt, /undefined|null/);
});

it('merges a late session.created into a start begun from a reply, and keeps its context for later Devin sessions', async (t) => {
  const h = setup(t);
  await h.connect();
  const created = h.shortcut.open();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Pick this up (private-prompt)'))).status, 200);
  assert.equal((await h.deliver(created)).status, 200);
  await h.tick();
  const devin = h.devin.only();
  assert.match(devin.prompt, /Please fix the Safari login bug[^]*Pick this up/);
  assert.match(devin.prompt, /Login fails on Safari\./);
  assertAbout(await h.alarmIn(), 5_000, 'polling');

  const late = setup(t);
  await late.connect();
  const opened = late.shortcut.open();
  assert.equal((await late.deliver(late.shortcut.prompt(SID, 'Pick this up (private-prompt)'))).status, 200);
  await late.tick();
  assert.doesNotMatch(late.devin.only().prompt, /Login fails on Safari/);
  assert.equal((await late.deliver(opened)).status, 200);
  await late.tick();
  assert.equal((await late.deliver(late.shortcut.stop(SID))).status, 200);
  await late.tick();
  assert.equal((await late.deliver(late.shortcut.prompt(SID, 'Try again (private-prompt)'))).status, 200);
  await late.tick();
  assert.equal(late.devin.sessions.length, 2);
  assert.match(late.devin.sessions[1].prompt, /Login fails on Safari\./);
});

it('retries a conflicting link update once with the fresh version, then gives up quietly', async (t) => {
  const h = setup(t);
  await h.connect();
  h.shortcut.state.patchConflicts = 1;
  assert.equal((await h.deliver(h.shortcut.open())).status, 200);
  await h.tick();
  const patches = h.requests.filter((r) => r.method === 'PATCH').map((r) => JSON.parse(r.body).version);
  assert.deepEqual(patches, [1, 2]);
  assert.deepEqual(h.shortcut.sessions.get(SID).external_urls, [{ label: 'Open in Devin', url: h.devin.only().url }]);

  const twice = setup(t);
  await twice.connect();
  twice.shortcut.state.patchConflicts = 2;
  assert.equal((await twice.deliver(twice.shortcut.open())).status, 200);
  await twice.tick();
  assert.equal(twice.requests.filter((r) => r.method === 'PATCH').length, 2);
  assert.deepEqual(twice.shortcut.sessions.get(SID).external_urls, []);
  assertAbout(await twice.alarmIn(), 5_000, 'polling continues without the link');
});

it('adopts a Devin session already tagged for this Shortcut session instead of creating another', async (t) => {
  const h = setup(t);
  const existing = h.devin.seed({ tags: ['shortcut-session-sess-1-1'] });
  h.devin.seed({ tags: ['shortcut-session-sess-9-1'] });
  await h.connect();
  assert.equal((await h.deliver(h.shortcut.open())).status, 200);
  await h.tick();
  assert.equal(h.devinCalls('POST', /\/sessions$/).length, 0);
  assert.deepEqual(h.shortcut.sessions.get(SID).external_urls, [{ label: 'Open in Devin', url: existing.url }]);

  const deep = setup(t);
  deep.devin.state.ignoreTagFilter = true;
  for (let i = 0; i < 150; i++) deep.devin.seed({ tags: [`shortcut-session-other-${i}`] });
  const buried = deep.devin.seed({ tags: ['shortcut-session-sess-1-1'] });
  await deep.connect();
  assert.equal((await deep.deliver(deep.shortcut.open())).status, 200);
  await deep.tick();
  assert.equal(deep.devinCalls('POST', /\/sessions$/).length, 0);
  assert.deepEqual(deep.shortcut.sessions.get(SID).external_urls, [{ label: 'Open in Devin', url: buried.url }]);
});

it('never creates a Devin session on a malformed session list, and creates after 5 pages of 100 without a match', async (t) => {
  const h = setup(t);
  h.devin.state.malformedList = true;
  await h.connect();
  assert.equal((await h.deliver(h.shortcut.open())).status, 200);
  await h.tick();
  assert.equal(h.devin.sessions.length, 0);
  assertAbout(await h.alarmIn(), 5_000, 'a malformed list is transient');
  h.devin.state.malformedList = false;
  await h.tick();
  assert.equal(h.devin.sessions.length, 1);

  const crowded = setup(t);
  crowded.devin.state.ignoreTagFilter = true;
  for (let i = 0; i < 501; i++) crowded.devin.seed({ tags: [`shortcut-session-other-${i}`] });
  await crowded.connect();
  assert.equal((await crowded.deliver(crowded.shortcut.open())).status, 200);
  await crowded.tick();
  assert.equal(crowded.devin.sessions.length, 502);
  const pages = crowded.requests.filter((r) => r.origin === 'devin' && r.method === 'GET' && r.path.endsWith('/sessions'));
  assert.equal(pages.length, 5);
  assert.ok(pages.every((r) => r.query.includes('first=100')));
  assert.equal(crowded.logs.filter(([level, message]) => level === 'warn' && /pages/.test(message)).length, 1);
  crowded.assertCleanLogs();
});

it('keeps the Devin session a start created when the relay of a queued reply fails', async (t) => {
  const h = setup(t);
  h.devin.state.ignoreTagFilter = true;
  for (let i = 0; i < 501; i++) h.devin.seed({ tags: [`shortcut-session-other-${i}`] });
  await h.connect();
  assert.equal((await h.deliver(h.shortcut.open())).status, 200);
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox (private-prompt)'))).status, 200);
  h.devin.failNext(502, {}, /^POST .*\/messages$/);
  await h.tick();
  await h.tick();
  assert.equal(h.devin.sessions.length, 502, 'one Devin session for the Shortcut session');
  assert.deepEqual(h.devin.sessions[501].received, ['Also fix Firefox (private-prompt)']);
  assertAbout(await h.alarmIn(), 5_000, 'polling after the relay');
});

it('relays a late session.created to a start whose create was already attempted', async (t) => {
  const h = setup(t);
  await h.connect();
  const created = h.shortcut.open();
  h.devin.state.loseCreate = true;
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Pick this up (private-prompt)'))).status, 200);
  await h.tick();
  const devin = h.devin.only();
  assert.equal((await h.deliver(created)).status, 200);
  for (let i = 0; i < 3; i++) await h.tick();
  assert.equal(h.devin.sessions.length, 1);
  assert.doesNotMatch(devin.prompt, /Login fails on Safari/);
  assert.equal(devin.received.length, 1);
  assert.match(devin.received[0], /Please fix the Safari login bug/);
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  await h.tick();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Try again (private-prompt)'))).status, 200);
  await h.tick();
  assert.match(h.devin.sessions[1].prompt, /Login fails on Safari\./, 'the context reaches the next Devin session');
});

it('fails closed on a session page that claims a next page without a cursor or lacks has_next_page, and skips malformed sessions that are not tagged', async (t) => {
  const h = setup(t);
  await h.connect();
  h.devin.state.listPatch = { has_next_page: true, end_cursor: null };
  assert.equal((await h.deliver(h.shortcut.open())).status, 200);
  await h.tick();
  assert.equal(h.devin.sessions.length, 0, 'a cursorless next page never authorizes a create');
  assertAbout(await h.alarmIn(), 5_000, 'transient');
  h.devin.state.listPatch = { has_next_page: undefined };
  await h.tick();
  assert.equal(h.devin.sessions.length, 0, 'a missing has_next_page never authorizes a create');
  h.devin.state.listPatch = null;
  await h.tick();
  assert.equal(h.devin.sessions.length, 1);

  const mixed = setup(t);
  mixed.devin.state.extraItems = [{ session_id: 42 }, { session_id: 'other', url: 'https://app.devin.ai/sessions/other', status: 'running', tags: ['shortcut-session-sess-9-1'] }];
  const existing = mixed.devin.seed({ tags: ['shortcut-session-sess-1-1'] });
  await mixed.connect();
  assert.equal((await mixed.deliver(mixed.shortcut.open())).status, 200);
  await mixed.tick();
  assert.equal(mixed.devinCalls('POST', /\/sessions$/).length, 0);
  assert.deepEqual(mixed.shortcut.sessions.get(SID).external_urls, [{ label: 'Open in Devin', url: existing.url }]);
});

it('relays a late session.created to the first Devin session once it is running, and only keeps its context in a later generation', async (t) => {
  const h = setup(t);
  await h.connect();
  const created = h.shortcut.open();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Pick this up (private-prompt)'))).status, 200);
  await h.tick();
  const devin = h.devin.only();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  assert.equal((await h.deliver(created)).status, 200);
  await h.tick();
  assert.equal(devin.received.length, 1);
  assert.match(devin.received[0], /Please fix the Safari login bug/);
  assert.match(devin.received[0], /Login fails on Safari\./);
  assert.equal(h.devin.sessions.length, 1);
  assertAbout(await h.alarmIn(), 5_000, 'polling after the relay');

  const later = setup(t);
  await later.connect();
  const opened = later.shortcut.open();
  assert.equal((await later.deliver(later.shortcut.prompt(SID, 'Pick this up (private-prompt)'))).status, 200);
  await later.tick();
  Object.assign(later.devin.only(), { status: 'running', status_detail: 'working' });
  assert.equal((await later.deliver(later.shortcut.stop(SID))).status, 200);
  await later.tick();
  assert.equal((await later.deliver(later.shortcut.prompt(SID, 'Try again (private-prompt)'))).status, 200);
  assert.equal((await later.deliver(opened)).status, 200);
  await later.tick();
  assert.equal(later.devin.sessions.length, 2);
  const second = later.devin.sessions[1];
  assert.doesNotMatch(second.prompt, /Please fix the Safari login bug/, 'the stopped request is not revived');
  assert.match(second.prompt, /Login fails on Safari\./);
  assert.deepEqual(second.received, []);
});

it('relays replies delivered out of order in turn order', async (t) => {
  const h = setup(t);
  await h.connect();
  h.shortcut.open();
  const second = h.shortcut.prompt(SID, 'Fix Firefox (private-prompt)');
  const third = h.shortcut.prompt(SID, 'Also add tests (private-prompt)');
  assert.equal((await h.deliver(third)).status, 200);
  assert.equal((await h.deliver(second)).status, 200);
  await h.tick();
  assert.match(h.devin.only().prompt, /Fix Firefox[^]*Also add tests/);
  assert.equal(h.shortcut.activities().find((a) => a.key === 'devin-bridge:3:ack').turn, 3);

  const relay = setup(t);
  const devin = await relay.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  await relay.tick();
  const two = relay.shortcut.prompt(SID, 'Fix Firefox (private-prompt)');
  const three = relay.shortcut.prompt(SID, 'Also add tests (private-prompt)');
  assert.equal((await relay.deliver(three)).status, 200);
  assert.equal((await relay.deliver(two)).status, 200);
  await relay.tick();
  assert.deepEqual(devin.received, ['Fix Firefox (private-prompt)\n\nAlso add tests (private-prompt)']);
});

it('adopts the oldest of several Devin sessions under the tag and retires the rest', async (t) => {
  const h = setup(t);
  const newer = h.devin.seed({ tags: ['shortcut-session-sess-1-1'], created_at: 20 });
  const older = h.devin.seed({ tags: ['shortcut-session-sess-1-1'], created_at: 10 });
  await h.connect();
  assert.equal((await h.deliver(h.shortcut.open())).status, 200);
  await h.tick();
  assert.equal(h.devinCalls('POST', /\/sessions$/).length, 0);
  assert.deepEqual(h.shortcut.sessions.get(SID).external_urls, [{ label: 'Open in Devin', url: older.url }]);
  assert.equal(newer.terminated, true);
  assert.equal(older.terminated, undefined);
  assertAbout(await h.alarmIn(), 5_000, 'polling the adopted session');
});

it('closes at once when linking finds the Shortcut session gone or closed', async (t) => {
  for (const [label, prepare] of [['gone', (h) => h.shortcut.state.readFailures.push(404)], ['closed', (h) => { h.shortcut.sessions.get(SID).closed_reason = 'archived'; }]]) {
    const h = setup(t);
    await h.connect();
    assert.equal((await h.deliver(h.shortcut.open())).status, 200);
    prepare(h);
    await h.tick();
    const devin = h.devin.only();
    assert.equal(devin.terminated, true, `${label}: the new Devin session is retired`);
    assert.equal(await h.alarmIn(), null, label);
    assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Anyone? (private-prompt)'))).status, 200);
    await h.tick();
    assert.deepEqual(devin.received, [], label);
    assert.equal(h.devin.sessions.length, 1, label);
  }
});

it('keeps only the context from a session.created that arrives after the turn was answered', async (t) => {
  const h = setup(t);
  await h.connect();
  const created = h.shortcut.open();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Pick this up (private-prompt)'))).status, 200);
  await h.tick();
  const devin = h.devin.only();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  h.devin.say(devin, 'Done (private-devin-text)');
  await h.tick();
  const writes = () => h.requests.filter((r) => r.origin === 'shortcut' && r.method === 'POST').length;
  const before = writes();
  assert.equal((await h.deliver(created)).status, 200);
  await h.tick();
  assert.deepEqual(devin.received, [], 'an answered turn relays nothing');
  assert.equal(writes(), before, 'nothing is written to a finished turn');
  assert.equal(await h.alarmIn(), null);
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  await h.tick();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Try again (private-prompt)'))).status, 200);
  await h.tick();
  assert.match(h.devin.sessions[1].prompt, /Login fails on Safari\./, 'the next Devin session gets the context');
});

it('sets the Devin link once Shortcut recovers, and a link set resets the Shortcut failure count', async (t) => {
  const h = setup(t);
  await h.connect();
  h.shortcut.state.readFailures.push(503);
  assert.equal((await h.deliver(h.shortcut.open())).status, 200);
  await h.tick();
  const devin = h.devin.only();
  assert.deepEqual(h.shortcut.sessions.get(SID).external_urls, []);
  assertAbout(await h.alarmIn(), 5_000, 'the link retries with the first poll');
  await h.tick();
  assert.deepEqual(h.shortcut.sessions.get(SID).external_urls, [{ label: 'Open in Devin', url: devin.url }]);
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  h.shortcut.state.serverErrors = 1;
  h.devin.say(devin, 'Cloning (private-devin-text)');
  await h.tick();
  assertAbout(await h.alarmIn(), 5_000, 'the first write failure after the link backs off 5 s');

  const limited = setup(t);
  await limited.connect();
  limited.shortcut.state.readRateLimits.push('30');
  assert.equal((await limited.deliver(limited.shortcut.open())).status, 200);
  await limited.tick();
  assert.deepEqual(limited.shortcut.sessions.get(SID).external_urls, []);
  assertAbout(await limited.alarmIn(), 5_000, 'the poll is not held by the link');
  const limitedAt = Date.now();
  for (let i = 0; i < 6 && limited.shortcut.sessions.get(SID).external_urls.length === 0; i++) await limited.tick();
  assert.ok(Date.now() - limitedAt >= 30_000, 'the link waited for Retry-After');
  assert.deepEqual(limited.shortcut.sessions.get(SID).external_urls, [{ label: 'Open in Devin', url: limited.devin.only().url }]);
});

it('joins replies that wait on one send in turn order, however they arrive', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  await h.tick();
  const two = h.shortcut.prompt(SID, 'Two (private-prompt)');
  const three = h.shortcut.prompt(SID, 'Three (private-prompt)');
  const four = h.shortcut.prompt(SID, 'Four (private-prompt)');
  for (const event of [two, four, three]) assert.equal((await h.deliver(event)).status, 200);
  await h.tick();
  assert.deepEqual(devin.received, ['Two (private-prompt)\n\nThree (private-prompt)\n\nFour (private-prompt)']);

  const stopped = setup(t);
  const first = await stopped.started();
  Object.assign(first, { status: 'running', status_detail: 'working' });
  assert.equal((await stopped.deliver(stopped.shortcut.stop(SID))).status, 200);
  const b = stopped.shortcut.prompt(SID, 'Two (private-prompt)');
  const c = stopped.shortcut.prompt(SID, 'Three (private-prompt)');
  const d = stopped.shortcut.prompt(SID, 'Four (private-prompt)');
  for (const event of [b, d, c]) assert.equal((await stopped.deliver(event)).status, 200);
  await stopped.tick();
  assert.match(stopped.devin.sessions[1].prompt, /Two \(private-prompt\)\n\nThree \(private-prompt\)\n\nFour \(private-prompt\)/);
});

it('sends only the context of a session.created that arrives after the first turn was answered, ahead of the next reply', async (t) => {
  const h = setup(t);
  await h.connect();
  const created = h.shortcut.open();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Pick this up (private-prompt)'))).status, 200);
  await h.tick();
  const devin = h.devin.only();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  h.devin.say(devin, 'Done (private-devin-text)');
  await h.tick();
  assert.equal((await h.deliver(created)).status, 200);
  await h.tick();
  assert.deepEqual(devin.received, [], 'nothing goes to Devin on its own');
  assert.equal(await h.alarmIn(), null);
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Next (private-prompt)'))).status, 200);
  await h.tick();
  assert.equal(devin.received.length, 1);
  assert.match(devin.received[0], /^Context from Shortcut:\n\nStory 123[^]*Login fails on Safari\.\n\nNext \(private-prompt\)$/);
  assert.doesNotMatch(devin.received[0], /Please fix the Safari login bug/, 'the answered request is not sent again');

  const relaying = setup(t);
  await relaying.connect();
  const opened = relaying.shortcut.open();
  assert.equal((await relaying.deliver(relaying.shortcut.prompt(SID, 'Pick this up (private-prompt)'))).status, 200);
  await relaying.tick();
  const other = relaying.devin.only();
  Object.assign(other, { status: 'running', status_detail: 'finished' });
  relaying.devin.say(other, 'Done (private-devin-text)');
  await relaying.tick();
  assert.equal((await relaying.deliver(relaying.shortcut.prompt(SID, 'Next (private-prompt)'))).status, 200);
  assert.equal((await relaying.deliver(opened)).status, 200);
  await relaying.tick();
  assert.equal(other.received.length, 1);
  assert.match(other.received[0], /^Context from Shortcut:\n\nStory 123[^]*Login fails on Safari\.\n\nNext \(private-prompt\)$/);
  assert.doesNotMatch(other.received[0], /Please fix the Safari login bug/, 'a reply still unsent does not revive the answered request');
});

it('gives the card link up after 8 failed attempts, so a session is not woken for it again', async (t) => {
  const h = setup(t);
  await h.connect();
  for (let i = 0; i < 9; i++) h.shortcut.state.readFailures.push(503);
  assert.equal((await h.deliver(h.shortcut.open())).status, 200);
  await h.tick();
  const devin = h.devin.only();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  const reads = () => h.requests.filter((r) => r.origin === 'shortcut' && r.method === 'GET' && r.path.endsWith(`/${SID}`)).length;
  assert.equal(reads(), 1);
  // Devin keeps talking, so the poll never reaches the quiet cap and the session reads are the link's alone.
  for (let i = 0; i < 80 && reads() < 8; i++) {
    h.devin.say(devin, 'Working (private-devin-text)');
    await h.tick();
  }
  assert.equal(reads(), 8);
  for (let i = 0; i < 20; i++) {
    h.devin.say(devin, 'Working (private-devin-text)');
    await h.tick();
  }
  assert.equal(reads(), 8, 'the link is given up');
  devin.status_detail = 'finished';
  await h.tick();
  assert.equal(h.shortcut.activities().filter((a) => a.content.type === 'response').length, 1);
  assert.equal(await h.alarmIn(), null);
  assert.deepEqual(h.shortcut.sessions.get(SID).external_urls, []);
  h.assertCleanLogs();
});

it('gives a new Devin session\'s card link a full budget', async (t) => {
  const h = setup(t);
  await h.connect();
  for (let i = 0; i < 3; i++) h.shortcut.state.readFailures.push(503);
  assert.equal((await h.deliver(h.shortcut.open())).status, 200);
  await h.tick();
  const first = h.devin.only();
  Object.assign(first, { status: 'running', status_detail: 'working' });
  const reads = () => h.requests.filter((r) => r.origin === 'shortcut' && r.method === 'GET' && r.path.endsWith(`/${SID}`)).length;
  for (let i = 0; i < 10 && reads() < 3; i++) await h.tick();
  assert.equal(reads(), 3, 'three link attempts failed');
  assert.deepEqual(h.shortcut.sessions.get(SID).external_urls, []);
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  await h.tick();
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Again (private-prompt)'))).status, 200);
  await h.tick();
  assert.equal(h.devin.sessions.length, 2);
  assert.deepEqual(h.shortcut.sessions.get(SID).external_urls, [{ label: 'Open in Devin', url: h.devin.sessions[1].url }], 'the new session is linked at once');
});

it('folds a late session.created into a create that has not gone out, whatever replies arrived meanwhile', async (t) => {
  const h = setup(t);
  await h.connect();
  const created = h.shortcut.open();
  const two = h.shortcut.prompt(SID, 'Pick this up (private-prompt)');
  const three = h.shortcut.prompt(SID, 'Also Firefox (private-prompt)');
  for (const event of [two, three, created]) assert.equal((await h.deliver(event)).status, 200);
  await h.tick();
  const devin = h.devin.only();
  assert.match(devin.prompt, /Please fix the Safari login bug[^]*Pick this up/);
  assert.match(devin.prompt, /Login fails on Safari\./);
  assert.deepEqual(devin.received, ['Also Firefox (private-prompt)'], 'the context is sent once, in the create');
});

it('still relays the opening request when a relay ahead of it is resent after a newer reply started the session', async (t) => {
  const h = setup(t);
  await h.connect();
  const created = h.shortcut.open(SID, { body: 'Please fix X (private-prompt)' });
  const two = h.shortcut.prompt(SID, 'Two (private-prompt)');
  const three = h.shortcut.prompt(SID, 'Three (private-prompt)');
  assert.equal((await h.deliver(three)).status, 200);
  h.devin.state.loseCreate = true;
  await h.tick();
  assert.equal((await h.deliver(two)).status, 200);
  h.devin.failNext(503, {}, /^POST .*\/messages$/);
  for (let i = 0; i < 2; i++) await h.tick();
  assert.equal((await h.deliver(created)).status, 200);
  for (let i = 0; i < 4; i++) await h.tick();
  const devin = h.devin.only();
  assert.ok(devin.received.some((message) => /Please fix X/.test(message) && /Context from Shortcut/.test(message)), `opening request reached Devin: ${JSON.stringify(devin.received)}`);
});
