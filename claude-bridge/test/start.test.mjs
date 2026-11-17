import assert from 'node:assert/strict';
import { it } from 'node:test';
import { AGENT, ENVIRONMENT, SID, consoleUrl, openingText, setup } from './harness.mjs';

it('creates an idle session for the configured agent and environment, then sends the opening request as its first message', async (t) => {
  const h = setup(t);
  const session = await h.started();
  const creates = h.claudeCalls('POST', /^\/v1\/sessions$/);
  assert.equal(creates.length, 1);
  assert.deepEqual(JSON.parse(creates[0].body), { agent: AGENT, environment_id: ENVIRONMENT, title: 'Shortcut story 123', metadata: { shortcut_session: `shortcut-session-${SID}-1` } },
    'no initial_events: the create starts no work, so one lost to a crash costs nothing');
  assert.deepEqual(h.sent(), [{ type: 'user.message', content: [{ type: 'text', text: openingText() }] }]);
  assert.deepEqual(h.shortcut.sessions.get(SID).external_urls, [{ label: 'Open in Claude Console', url: consoleUrl(session) }]);
  h.assertCleanLogs();
});

it('links the Default workspace when CLAUDE_CONSOLE_WORKSPACE_ID is default', async (t) => {
  const h = setup(t);
  h.env.CLAUDE_CONSOLE_WORKSPACE_ID = 'default';
  const session = await h.started();
  assert.deepEqual(h.shortcut.sessions.get(SID).external_urls, [{ label: 'Open in Claude Console', url: `https://platform.claude.com/workspaces/default/sessions/${session.id}` }]);
});

it('leaves a session whose create answer was lost empty and idle, and tells only the next one the request', async (t) => {
  const h = setup(t);
  await h.connect();
  h.claude.state.lose = 'open';
  assert.equal((await h.deliver(h.shortcut.open())).status, 200);
  for (let i = 0; i < 4 && h.claude.sessions.length < 2; i++) await h.tick();
  const [lost, kept] = h.claude.sessions;
  assert.deepEqual([lost.status, lost.events, h.claudeCalls('POST', new RegExp(`${lost.id}/events$`))], ['idle', [], []], 'nothing is ever sent to the lost session');
  assert.deepEqual(kept.received, [openingText()]);
  assert.deepEqual(h.shortcut.sessions.get(SID).external_urls, [{ label: 'Open in Claude Console', url: consoleUrl(kept) }]);
  h.assertCleanLogs();
});

it('introduces the session once even when the event list leaves queued messages out', async (t) => {
  const h = setup(t);
  h.claude.state.hideQueued = true;
  const session = await h.started();
  for (let i = 0; i < 3; i++) await h.tick();
  assert.deepEqual(session.received, [openingText()]);
  assert.deepEqual(h.shortcut.activities().map((a) => a.content.type), ['thought'], 'a message the agent has not taken yet is not an answer');
  h.claude.say(session, 'Fixed it');
  h.claude.finish(session);
  await h.tick();
  assert.deepEqual(h.shortcut.activities().filter((a) => a.content.type === 'response').map((a) => a.content.body), [`Fixed it\n\n[Open in Claude Console](${consoleUrl(session)})`]);
});

it('trims and encodes CLAUDE_CONSOLE_WORKSPACE_ID in the link, and links nothing when it is blank', async (t) => {
  const odd = setup(t);
  odd.env.CLAUDE_CONSOLE_WORKSPACE_ID = ' team a/b ';
  const session = await odd.started();
  assert.deepEqual(odd.shortcut.sessions.get(SID).external_urls, [{ label: 'Open in Claude Console', url: `https://platform.claude.com/workspaces/team%20a%2Fb/sessions/${session.id}` }]);
  const named = setup(t);
  await named.connect();
  named.claude.state.answer = { call: 'open', body: { type: 'session', id: 'sesn a/b' } };
  assert.equal((await named.deliver(named.shortcut.open())).status, 200);
  await named.tick();
  assert.deepEqual(named.shortcut.sessions.get(SID).external_urls, [{ label: 'Open in Claude Console', url: 'https://platform.claude.com/workspaces/wrkspc_acme/sessions/sesn%20a%2Fb' }]);
  const blank = setup(t);
  blank.env.CLAUDE_CONSOLE_WORKSPACE_ID = '  ';
  await blank.started();
  assert.deepEqual(blank.shortcut.sessions.get(SID).external_urls, []);
});

it('creates another session when the create answers without an id, and sends the first one nothing', async (t) => {
  for (const body of [{ type: 'session' }, { type: 'session', id: 7 }]) {
    const h = setup(t);
    await h.connect();
    h.claude.state.answer = { call: 'open', body };
    assert.equal((await h.deliver(h.shortcut.open())).status, 200);
    for (let i = 0; i < 4 && h.claude.sessions.length < 2; i++) await h.tick();
    const [unnamed, kept] = h.claude.sessions;
    assert.deepEqual([unnamed.events, kept.received], [[], [openingText()]]);
    assert.deepEqual(h.shortcut.sessions.get(SID).external_urls, [{ label: 'Open in Claude Console', url: consoleUrl(kept) }]);
  }
});

/** The opening message reached the session and the agent took it, but the bridge never got the send's answer, and a stop cancelled the retry. */
async function toldUnconfirmed(t) {
  const h = setup(t, { linked: false });
  await h.connect();
  h.claude.state.lose = 'send';
  assert.equal((await h.deliver(h.shortcut.open())).status, 200);
  await h.tick();
  const session = h.claude.only();
  assert.deepEqual(session.received, [openingText()]);
  h.claude.work(session);
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  for (let i = 0; i < 3; i++) await h.tick();
  return { h, session };
}

it('does not introduce a session again when a message is in it that the bridge never saw confirmed', async (t) => {
  const { h, session } = await toldUnconfirmed(t);
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox'))).status, 200);
  for (let i = 0; i < 4; i++) await h.tick();
  assert.deepEqual(session.received, [openingText(), 'Also fix Firefox']);
});

it('opens a new session for the reply when a session that was told something is terminated', async (t) => {
  const { h, session } = await toldUnconfirmed(t);
  h.claude.terminate(session);
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox'))).status, 200);
  for (let i = 0; i < 4; i++) await h.tick();
  assert.deepEqual(h.shortcut.activities().filter((a) => a.content.type === 'error'), [], 'it was not empty, so the reply is not dropped with it');
  assert.deepEqual(h.claude.sessions.map((each) => each.received), [[openingText()], [openingText('Also fix Firefox')]]);
});

it('fails the turn without a new session when a session that was told nothing is terminated', async (t) => {
  const h = setup(t, { linked: false });
  await h.connect();
  h.claude.failNext(503, {}, /^GET \/v1\/sessions\/[^/]+$/);
  assert.equal((await h.deliver(h.shortcut.open())).status, 200);
  await h.tick();
  const session = h.claude.only();
  h.claude.terminate(session);
  for (let i = 0; i < 4; i++) await h.tick();
  assert.deepEqual(h.shortcut.activities().filter((a) => a.content.type === 'error').map((a) => a.content.body), ['The Claude session ended before it took your message. Reply to start a new one.']);
  assert.deepEqual([h.claude.sessions.length, session.received], [1, []]);
});
