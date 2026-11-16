import assert from 'node:assert/strict';
import { it } from 'node:test';
import { AGENT_ID, SID, assertAbout, openingText, setup } from './harness.mjs';

const KEY = 'shortcut-session-sess-1-1';

it('looks the key up, then creates the session with the opening text as its input, and sets no card link', async (t) => {
  const h = setup(t);
  const session = await h.started();

  const [lookup, create] = h.requests.filter((r) => r.origin === 'openai');
  assert.deepEqual([lookup.method, lookup.path, Object.fromEntries(new URLSearchParams(lookup.query))],
    ['GET', '/v1/agents/sessions', { 'metadata[shortcut_session]': KEY, order: 'asc', limit: '100' }]);
  assert.deepEqual([create.method, create.path, JSON.parse(create.body)],
    ['POST', '/v1/agents/sessions', { agent_id: AGENT_ID, environment: { type: 'none' }, input: openingText(), metadata: { shortcut_session: KEY } }]);
  assert.deepEqual(h.requests.filter((r) => r.origin === 'openai').map((r) => r.beta), ['agents=v1', 'agents=v1']);
  assert.equal(session.received.length, 0, 'the create carried the text, so nothing follows it as a message');
  assert.equal(h.requests.filter((r) => r.origin === 'shortcut' && r.method === 'PATCH').length, 0, 'the Agents API has no page for one session');
  assertAbout(await h.alarmIn(), 5_000, 'first poll');
  h.assertCleanLogs();
});

it('runs the session in an OpenAI-hosted environment when a template is configured', async (t) => {
  const h = setup(t);
  h.env.OPENAI_ENVIRONMENT_TEMPLATE_ID = 'envtmpl_shortcut';
  await h.started();
  const create = h.openaiCalls('POST', /\/sessions$/)[0];
  assert.deepEqual(JSON.parse(create.body).environment, { type: 'openai_hosted', environment_template_id: 'envtmpl_shortcut' });
});

it('adopts the oldest session under the key, creates none, and cancels the others', async (t) => {
  const h = setup(t);
  const older = h.openai.seed({ metadata: { shortcut_session: KEY }, opened: openingText(), inbox: [{ kind: 'message', text: openingText() }] });
  const newer = h.openai.seed({ metadata: { shortcut_session: KEY }, opened: openingText(), inbox: [{ kind: 'message', text: openingText() }] });
  h.openai.work(newer);
  await h.connect();
  await h.deliver(h.shortcut.open());
  await h.tick();
  await h.tick();

  assert.equal(h.openaiCalls('POST', /\/sessions$/).length, 0);
  assert.deepEqual([older.cancels, newer.cancels], [0, 1]);
  assert.equal(newer.turns[0].status, 'cancelled');
  h.openai.work(older);
  h.openai.say(older, 'Fixed it', 'final_answer');
  h.openai.finish(older);
  await h.tick();
  assert.deepEqual(h.shortcut.activities().filter((a) => a.content.type === 'response').map((a) => a.content.body), ['Fixed it']);
});

it('adopts nothing a lookup returns under another key, even when the filter is ignored', async (t) => {
  const h = setup(t);
  h.openai.state.ignoreFilter = true;
  const other = h.openai.seed({ metadata: { shortcut_session: 'shortcut-session-other-1' } });
  await h.connect();
  await h.deliver(h.shortcut.open());
  await h.tick();
  assert.equal(h.openai.sessions.length, 2);
  assert.equal(h.openai.sessions[1].opened, openingText());
  assert.equal(other.cancels, 0);
});

it('adopts the session a lost create made, so the request reaches one session once', async (t) => {
  const h = setup(t);
  await h.connect();
  h.openai.state.loseCreate = true;
  await h.deliver(h.shortcut.open());
  await h.tick();
  assertAbout(await h.alarmIn(), 5_000, 'retry after the lost create response');
  await h.deliver(h.shortcut.prompt(SID, 'Also fix Firefox (private-prompt)'));
  await h.tick();
  await h.tick();

  const session = h.openai.only();
  assert.equal(h.openaiCalls('POST', /\/sessions$/).length, 1);
  assert.deepEqual(session.received, ['Also fix Firefox (private-prompt)'], 'the reply that arrived meanwhile follows as a message');
  h.assertCleanLogs();
});

it('creates no session while the lookup of its key is cut short', async (t) => {
  const h = setup(t);
  h.openai.state.ignoreFilter = true;
  for (let i = 0; i < 501; i++) h.openai.seed({ metadata: { shortcut_session: 'shortcut-session-other-1' } });
  await h.connect();
  await h.deliver(h.shortcut.open());
  await h.tick();
  assert.equal(h.openaiCalls('GET', /\/sessions$/).length, 5, 'the lookup reads 5 pages');
  assert.equal(h.openaiCalls('POST', /\/sessions$/).length, 0, 'a session under the key may be on a page the lookup did not read');
  assertAbout(await h.alarmIn(), 5_000, 'the open is retried');
});
