import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';
import { SECRETS, SENSITIVE, SID, assertAbout, mod, setup, shortcutHeaders } from './harness.mjs';

it('stores a redelivered event once, sequentially and concurrently', async (t) => {
  const h = setup(t);
  await h.connect();
  const event = h.shortcut.open();
  assert.equal((await h.deliver(event)).status, 200);
  const again = await h.deliver(event);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).duplicate, true);
  const concurrent = await Promise.all([h.deliver(event), h.deliver(event)]);
  assert.deepEqual(concurrent.map((r) => r.status), [200, 200]);
  await h.tick();
  await h.tick();
  assert.equal(h.devin.sessions.length, 1);
  assert.equal(h.posts(/:ack$/).length, 1);
  assert.equal(h.shortcut.activities().filter((a) => a.key.endsWith(':ack')).length, 1);
});

it('rejects bad, missing, stale, or Payload-Signature-only signatures without storing or calling anything', async (t) => {
  const h = setup(t);
  const body = JSON.stringify(h.shortcut.open());
  assert.equal((await h.request('/webhook', { method: 'POST', body })).status, 401);
  assert.equal((await h.request('/webhook', h.signed(body, 'wrong'))).status, 401);
  assert.equal((await h.request('/webhook', { method: 'POST', body, headers: shortcutHeaders(body, SECRETS.WEBHOOK_SECRET, '1700000000') })).status, 401);
  const legacy = createHmac('sha256', SECRETS.WEBHOOK_SECRET).update(body).digest('hex');
  assert.equal((await h.request('/webhook', { method: 'POST', body, headers: { 'Payload-Signature': legacy } })).status, 401);
  assert.equal(h.requests.length, 0);
  assert.equal(h.env.SESSIONS.storages.size, 0);
});

it('connects through OAuth, stores the credentials, enables sessions, and keeps secrets out of logs', async (t) => {
  const h = setup(t);
  const response = await h.request('/oauth/callback?code=private-code&state=private-state');
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), SENSITIVE);
  assert.deepEqual(h.shortcut.state.subscription, { enabled: true });
  const subscribe = h.requests.find((r) => r.path.endsWith('/agent-sessions/subscription'));
  assert.equal(subscribe.method, 'PUT');
  const stored = await (await h.env.WORKSPACES.get('workspace').fetch(new Request('https://workspace/credentials'))).json();
  assert.equal(stored.token, 'token-1');
  assert.equal(stored.slug, 'acme');
  assert.deepEqual(stored.scopes, ['read', 'write']);
  const connected = h.logs.find(([, message]) => message === 'Devin Bridge connected');
  assert.equal(connected[2].workspaceId, 'workspace');
  assert.equal(connected[2].sessionsEnabled, true);
  h.assertCleanLogs();

  const failing = setup(t);
  failing.shortcut.state.subscriptionStatus = 422;
  const partial = await failing.request('/oauth/callback?code=private-code&state=private-state');
  assert.equal(partial.status, 502);
  assert.match(await partial.text(), /Activate/);
  assert.equal(failing.logs.find(([, message]) => message === 'Devin Bridge connected')[2].sessionsEnabled, false);
  failing.assertCleanLogs();
});

it('refuses to connect a workspace that is not on the allowlist, and names its id', async (t) => {
  const h = setup(t);
  h.env.ALLOWED_WORKSPACE_IDS = 'other-workspace';
  const response = await h.request('/oauth/callback?code=private-code&state=private-state');
  assert.equal(response.status, 403);
  const page = await response.text();
  assert.match(page, /<code>workspace<\/code>/);
  assert.match(page, /ALLOWED_WORKSPACE_IDS/);
  assert.equal(h.shortcut.state.subscription, null);
  assert.equal(h.env.WORKSPACES.storages.size, 0);
  h.assertCleanLogs();
});

it('ignores session events from a workspace that is not on the allowlist', async (t) => {
  const h = setup(t);
  await h.connect();
  h.env.ALLOWED_WORKSPACE_IDS = 'other-workspace';
  assert.equal((await h.deliver(h.shortcut.open())).status, 200);
  assert.equal(h.env.SESSIONS.storages.size, 0);
  assert.equal(h.devin.sessions.length, 0);

});

it('refuses to connect a workspace whose id is empty, even when the allowlist has an empty entry', async (t) => {
  const h = setup(t);
  h.env.ALLOWED_WORKSPACE_IDS = 'other-workspace, ,';
  h.shortcut.state.workspaceId = '';
  const response = await h.request('/oauth/callback?code=private-code&state=private-state');
  assert.equal(response.status, 403);
  assert.equal(h.env.WORKSPACES.storages.size, 0);
});

it('applies an event that arrives while a step is waiting on Devin', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  const { release, reached } = h.devin.hold();
  const stepping = h.tick();
  await reached;
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'More (private-prompt)'))).status, 200);
  assert.deepEqual(devin.received, []);
  release();
  await stepping;
  assertAbout(await h.alarmIn(), 0, 'the step reschedules itself for the event');
  await h.tick();
  assert.deepEqual(devin.received, ['More (private-prompt)']);
});

it('closes a session whose workspace was taken off the allowlist before it ran', async (t) => {
  const h = setup(t);
  await h.connect();
  assert.equal((await h.deliver(h.shortcut.open())).status, 200);
  h.env.ALLOWED_WORKSPACE_IDS = 'other-workspace';
  await h.tick();
  assert.equal(h.devin.sessions.length, 0);
  assert.equal(h.shortcut.activities().length, 0);
  assert.equal(await h.alarmIn(), null);
});

it('refuses webhooks until the six delivery secrets are set and OAuth until all seven, answers validation, and keeps the health check bare', async (t) => {
  const h = setup(t);
  const body = '{"type":"validation"}';
  for (const key of Object.keys(SECRETS)) {
    const partial = { ...h.env, [key]: '' };
    assert.equal((await mod.default.request('/webhook', h.signed(body), partial)).status, key === 'ALLOWED_WORKSPACE_IDS' ? 200 : 503, key);
    assert.equal((await mod.default.request('/oauth/callback?code=x', undefined, partial)).status, 503, key);
  }
  assert.equal(h.requests.length, 0);
  assert.equal((await h.request('/webhook', h.signed(body))).status, 200);
  const health = await h.request('/');
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(await health.json()).sort(), ['service', 'status']);
});

it('a redelivered event restores a lost alarm', async (t) => {
  const h = setup(t);
  await h.connect();
  const event = h.shortcut.open();
  assert.equal((await h.deliver(event)).status, 200);
  await h.env.SESSIONS.storages.get(SID).deleteAlarm();
  assert.equal((await (await h.deliver(event)).json()).duplicate, true);
  assertAbout(await h.alarmIn(), 0, 'the duplicate sets the alarm');
  await h.tick();
  assert.equal(h.devin.sessions.length, 1);
});

it('applies an inbox event once when the step dies before clearing the inbox, and clears an inbox that changes nothing', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'Try Chrome (private-prompt)'))).status, 200);
  const storage = h.env.SESSIONS.storages.get(SID);
  const del = storage.delete;
  storage.delete = async () => {
    storage.delete = del;
    throw new Error('evicted');
  };
  await h.tick();
  assertAbout(await h.alarmIn(), 60_000, 'retry after a failed step');
  await h.tick();
  assert.equal(devin.terminated, true);
  assert.equal(h.devin.sessions.length, 2, 'the prompt that followed the stop still starts a new session');
  assert.match(h.devin.sessions[1].prompt, /Try Chrome/);

  const quiet = setup(t);
  await quiet.connect();
  quiet.shortcut.open();
  assert.equal((await quiet.deliver(quiet.shortcut.prompt(SID, { type: 'attachment', url: 'https://files.example/private-file.png' }))).status, 200);
  await quiet.tick();
  const keys = [...quiet.env.SESSIONS.storages.get(SID).data.keys()];
  assert.equal(keys.filter((key) => key.startsWith('inbox:')).length, 0);
  assert.equal(await quiet.alarmIn(), null);
});

it('forwards a stop from a workspace taken off the allowlist to its session, which closes and terminates Devin, and ignores other events', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'finished' });
  await h.tick();
  assert.equal(await h.alarmIn(), null);
  h.env.ALLOWED_WORKSPACE_IDS = 'other-workspace';
  assert.equal((await h.deliver(h.shortcut.prompt(SID, 'More (private-prompt)'))).status, 200);
  assert.equal(await h.alarmIn(), null, 'a reply from a workspace that is not allowed is ignored');
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  await h.tick();
  assert.equal(devin.terminated, true);
  assert.deepEqual(devin.received, []);
  assert.equal(await h.alarmIn(), null);

  const unknown = setup(t);
  await unknown.connect();
  unknown.env.ALLOWED_WORKSPACE_IDS = 'other-workspace';
  unknown.shortcut.open();
  assert.equal((await unknown.deliver(unknown.shortcut.stop(SID))).status, 200);
  assert.equal(unknown.env.SESSIONS.storages.get(SID)?.data.size ?? 0, 0, 'a stop for a session the bridge never saw stores nothing');

  const unset = setup(t);
  const other = await unset.started();
  Object.assign(other, { status: 'running', status_detail: 'working' });
  delete unset.env.ALLOWED_WORKSPACE_IDS;
  await unset.tick();
  assert.equal(other.terminated, true);
  assert.equal(unset.logs.filter(([, message]) => message === 'Devin Bridge step failed').length, 0);
});

it('keeps http.ts free of bridge imports', async () => {
  const http = await readFile(new URL('../src/http.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(http, /from '\.\/bridge'/);
});

it('serves webhooks without an allowlist, so an authenticated stop still terminates Devin, and refuses OAuth', async (t) => {
  const h = setup(t);
  const devin = await h.started();
  Object.assign(devin, { status: 'running', status_detail: 'working' });
  h.env.ALLOWED_WORKSPACE_IDS = '';
  assert.equal((await h.request('/webhook', h.signed('{"type":"validation"}'))).status, 200);
  const ignored = await h.deliver(h.shortcut.prompt(SID, 'More (private-prompt)'));
  assert.equal(ignored.status, 200);
  assert.equal((await ignored.json()).ignored, true);
  assert.equal((await h.deliver(h.shortcut.stop(SID))).status, 200);
  await h.tick();
  assert.equal(devin.terminated, true);
  assert.deepEqual(devin.received, []);
  assert.equal((await h.request('/oauth/callback?code=x')).status, 503);
});

it('clears an inbox of more than 128 events', async (t) => {
  const h = setup(t);
  await h.connect();
  h.shortcut.open();
  for (let i = 0; i < 129; i++) {
    assert.equal((await h.deliver(h.shortcut.prompt(SID, { type: 'attachment', url: `https://files.example/private-${i}.png` }))).status, 200);
  }
  await h.tick();
  const keys = [...h.env.SESSIONS.storages.get(SID).data.keys()];
  assert.equal(keys.filter((key) => key.startsWith('inbox:')).length, 0);
  assert.equal(h.logs.filter(([, message]) => message === 'Devin Bridge step failed').length, 0);
});
