import assert from 'node:assert/strict';
import { it } from 'node:test';
import { SID, assertAbout, setup } from './harness.mjs';

const responses = (h) => h.shortcut.activities().filter((a) => a.content.type === 'response').map((a) => [a.turn, a.content.body]);

it('cancels the working turn, answers "Stopped.", and keeps the session for the next reply', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.work(session);
  await h.deliver(h.shortcut.stop(SID));
  await h.tick();
  assert.deepEqual(h.submitted(), ['agent.session.input.cancel']);
  assert.equal(session.turns[0].status, 'cancelled');
  assert.deepEqual(responses(h), [[1, 'Stopped.']]);

  await h.deliver(h.shortcut.prompt(SID, 'Try Chrome instead'));
  await h.tick();
  assert.equal(h.openai.sessions.length, 1);
  assert.deepEqual(session.received, ['Try Chrome instead']);
  h.assertCleanLogs();
});

it('keeps the session when there is no turn to cancel', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.work(session);
  h.openai.say(session, 'Fixed it', 'final_answer');
  h.openai.finish(session);
  await h.tick();
  await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox'));
  await h.deliver(h.shortcut.stop(SID));
  await h.tick();
  assert.equal(session.cancels, 1);
  assert.deepEqual(responses(h), [[1, 'Fixed it'], [2, 'Stopped.']]);
  await h.deliver(h.shortcut.prompt(SID, 'Now Edge'));
  await h.tick();
  assert.deepEqual(session.received, ['Now Edge'], 'the stop cancelled the reply before it, and the next one goes to the kept session');
});

it('sends a reply that arrives while the stop is pending to the kept session', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.work(session);
  await h.deliver(h.shortcut.stop(SID));
  await h.deliver(h.shortcut.prompt(SID, 'Try Chrome instead'));
  await h.tick();
  assert.equal(h.openai.sessions.length, 1);
  assert.deepEqual(session.received, ['Try Chrome instead']);
  assert.ok(h.shortcut.activities().some((a) => a.key === 'openai-bridge:2:ack:kept'));
});

it('looks a lost create up again when a stop finds nothing under its key yet, and cancels what it finds', async (t) => {
  const h = setup(t);
  await h.connect();
  h.openai.state.loseCreate = true;
  h.openai.state.listLag = 2;
  await h.deliver(h.shortcut.open());
  await h.tick();
  const session = h.openai.only();
  await h.deliver(h.shortcut.stop(SID));
  for (let i = 0; i < 3 && responses(h).length === 0; i++) await h.tick();
  assert.deepEqual(responses(h), [[1, 'Stopped.']]);
  assert.equal(session.cancels, 0, 'the metadata filter does not show the session yet');
  const lookups = () => h.openaiCalls('GET', /\/sessions$/).length;
  const before = lookups();
  for (let i = 0; i < 4 && session.cancels === 0; i++) await h.tick();
  assert.equal(session.cancels, 1);
  assert.equal(lookups() - before, 2, 'retirement looked the key up twice more, and the second found it');
  assert.equal(h.openaiCalls('POST', /\/sessions$/).length, 1);
  h.assertCleanLogs();
});

it('cancels the turn when Shortcut closes the session, and keeps away from it after', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.work(session);
  h.shortcut.sessions.get(SID).closed = true;
  h.openai.say(session, 'Working on it');
  await h.tick();
  await h.tick();
  assert.equal(session.cancels, 1);
  const calls = h.requests.filter((r) => r.origin === 'openai').length;
  await h.deliver(h.shortcut.prompt(SID, 'Anyone there?'));
  await h.tick();
  assert.equal(h.requests.filter((r) => r.origin === 'openai').length, calls);
});

it('does not answer a stop as done while the lookup of the key is cut short', async (t) => {
  const h = setup(t);
  for (let i = 0; i < 501; i++) h.openai.work(h.openai.seed({ metadata: { shortcut_session: 'shortcut-session-sess-1-1' }, inbox: [{ kind: 'message', text: 'Opened' }] }));
  await h.connect();
  h.openai.failNext(503, {}, /GET \/v1\/agents\/sessions$/);
  await h.deliver(h.shortcut.open());
  await h.tick();
  await h.deliver(h.shortcut.stop(SID));
  for (let i = 0; i < 3; i++) await h.tick();
  assert.deepEqual(responses(h), [], 'a session the lookup did not reach may still be working');
  assert.ok(await h.alarmIn() > 0, 'the stop is tried again');
});

it('answers "Stopped." only once an accepted cancel has stopped the work', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.work(session);
  h.openai.state.slowCancel = true;
  await h.deliver(h.shortcut.stop(SID));
  await h.tick();
  assert.equal(session.cancels, 1);
  assert.deepEqual(responses(h), [], 'the cancel was accepted and the turn still works');
  assertAbout(await h.alarmIn(), 5_000, 'the stop is tried again');
  h.openai.settle(session);
  await h.tick();
  assert.deepEqual(responses(h), [[1, 'Stopped.']]);
  await h.deliver(h.shortcut.prompt(SID, 'Try Chrome instead'));
  await h.tick();
  assert.deepEqual([h.openai.sessions.length, session.received], [1, ['Try Chrome instead']], 'the session is kept');
});

it('reads the session after a cancel that answers 409, and cancels again while the turn works', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.work(session);
  h.openai.failNext(409, {}, /POST .*\/events$/);
  await h.deliver(h.shortcut.stop(SID));
  await h.tick();
  assert.deepEqual([session.turns[0].status, responses(h)], ['in_progress', []], 'a 409 does not show that nothing was running');
  await h.tick();
  assert.deepEqual([session.turns[0].status, responses(h)], ['cancelled', [[1, 'Stopped.']]]);
});

it('gives the session up when it still works after 8 cancels, and the next reply opens a new one', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.work(session);
  h.openai.state.slowCancel = true;
  await h.deliver(h.shortcut.stop(SID));
  const started = Date.now();
  while (responses(h).length === 0 && Date.now() - started < 600_000) await h.tick();
  assert.deepEqual([responses(h), session.cancels], [[[1, 'Stopped.']], 9], 'the stop cancels 8 times, and the retirement that follows cancels again');
  assertAbout(Date.now() - started, 255_000, 'the stop\'s budget');
  h.openai.state.slowCancel = false;
  await h.deliver(h.shortcut.prompt(SID, 'Try Chrome instead'));
  for (let i = 0; i < 3; i++) await h.tick();
  assert.equal(h.openai.sessions.length, 2);
  assert.match(h.openai.sessions[1].opened, /Try Chrome instead/);
  assert.deepEqual(session.received, []);
  assert.equal(session.turns[0].status, 'cancelled', 'the session that was given up is cancelled again until it stops');
});

for (const [condition, end] of [['failed', (h, s) => h.openai.failSession(s)], ['was deleted', (h, s) => { s.deleted = true; }]]) {
  it(`answers "Stopped." for a session that ${condition}, and the next reply opens a new one`, async (t) => {
    const h = setup(t);
    const session = await h.started();
    h.openai.work(session);
    end(h, session);
    await h.deliver(h.shortcut.stop(SID));
    await h.tick();
    assert.deepEqual(responses(h), [[1, 'Stopped.']]);
    await h.deliver(h.shortcut.prompt(SID, 'Try Chrome instead'));
    for (let i = 0; i < 2; i++) await h.tick();
    assert.equal(h.openai.sessions.length, 2);
    assert.ok(h.shortcut.activities().some((a) => a.key === 'openai-bridge:2:ack' && a.content.body === 'Starting a new OpenAI session.'), 'the stop already knew the session was over');
    assert.equal(h.openaiCalls('POST', new RegExp(`${session.id}/events$`)).length, 1, 'a session that is over is not cancelled again');
  });
}

it('answers "Stopped." and gives the session up when the cancel is refused with a 400', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.work(session);
  h.openai.failNext(400, {}, /POST .*\/events$/);
  await h.deliver(h.shortcut.stop(SID));
  await h.tick();
  assert.deepEqual(responses(h), [[1, 'Stopped.']]);
  await h.deliver(h.shortcut.prompt(SID, 'Try Chrome instead'));
  for (let i = 0; i < 3; i++) await h.tick();
  assert.deepEqual([h.openai.sessions.length, session.received], [2, []]);
});

it('sends the reply after a stop during a question as a message, not as the cancelled call\'s result', async (t) => {
  const h = setup(t);
  const session = await h.started();
  h.openai.ask(session, 'Which browser?');
  await h.tick();
  await h.deliver(h.shortcut.stop(SID));
  await h.tick();
  await h.deliver(h.shortcut.prompt(SID, 'Never mind, use Chrome'));
  await h.tick();
  assert.deepEqual(h.submitted(), ['agent.session.input.cancel', 'agent.session.input.message']);
  assert.deepEqual(session.received, ['Never mind, use Chrome']);
});

// The create's answer is lost and the metadata filter does not show the session yet, so the retried open creates a second one.
async function twoUnderOneKey(h) {
  await h.connect();
  Object.assign(h.openai.state, { loseCreate: true, listLag: 1 });
  await h.deliver(h.shortcut.open());
  await h.tick();
  await h.tick();
  assert.deepEqual(h.openai.sessions.map((s) => s.opened !== null), [true, true], 'both sessions were given the opening request');
  for (const session of h.openai.sessions) h.openai.work(session);
  return h.openai.sessions;
}

it('cancels every session under the conversation\'s key on a stop, and keeps the one it adopted', async (t) => {
  const h = setup(t);
  const [hidden, adopted] = await twoUnderOneKey(h);
  await h.deliver(h.shortcut.stop(SID));
  await h.tick();
  assert.deepEqual([hidden, adopted].map((s) => [s.cancels, s.turns[0].status]), [[1, 'cancelled'], [1, 'cancelled']]);
  assert.deepEqual(responses(h), [[1, 'Stopped.']]);
  await h.deliver(h.shortcut.prompt(SID, 'Try Chrome instead'));
  await h.tick();
  assert.deepEqual([hidden.received, adopted.received], [[], ['Try Chrome instead']]);
});

it('cancels every session under the conversation\'s key when Shortcut closes the session', async (t) => {
  const h = setup(t);
  const sessions = await twoUnderOneKey(h);
  h.shortcut.sessions.get(SID).closed = true;
  h.openai.say(sessions[1], 'Working on it');
  for (let i = 0; i < 3; i++) await h.tick();
  assert.deepEqual(sessions.map((s) => s.turns[0].status), ['cancelled', 'cancelled']);
});

it('does not answer "Stopped." while another session under the key still works', async (t) => {
  const h = setup(t);
  const [hidden] = await twoUnderOneKey(h);
  const { handle } = h.openai;
  h.openai.handle = (url, init) => (init.method === 'POST' && url.pathname === `/v1/agents/sessions/${hidden.id}/events` ? new Response(null, { status: 202 }) : handle(url, init));
  await h.deliver(h.shortcut.stop(SID));
  await h.tick();
  assert.deepEqual(responses(h), [], 'the cancel of the other session was accepted and it works on');
  h.openai.handle = handle;
  await h.tick();
  assert.deepEqual([hidden.turns[0].status, responses(h)], ['cancelled', [[1, 'Stopped.']]]);
});
