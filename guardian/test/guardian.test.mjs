import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';
import { build } from 'esbuild';

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
const compiled = await build({ stdin: { contents: source + '\nexport { listAll, alreadyWarned, startedStateIds, apiJson, guardStory, refreshCredentials, resolveActorMention };', resolveDir: new URL('../src', import.meta.url).pathname, loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', write: false });
const { listAll, alreadyWarned, startedStateIds, apiJson, guardStory, refreshCredentials, resolveActorMention, default: app } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text + '\n//# sourceURL=guardian-test-bundle.mjs').toString('base64')}`);
function session() {
  const data = new Map();
  const kv = { async get(k) { return data.get(k) ?? null; }, async put(k, v) { data.set(k, v); }, async list({ prefix }) { return { keys: [...data.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })) }; } };
  return { data, kv, workspaceId: 'workspace', env: { CLIENT_ID: 'client', CLIENT_SECRET: 'private-client', WEBHOOK_SECRET: 'signing', REDIRECT_URI: 'https://agent.example/callback', SHORTCUT_API_BASE: 'https://api.example.com', TOKENS: kv },
    creds: { token: 'private-access', refreshToken: 'private-refresh', memberId: 'guardian', slug: 'acme', expiresAt: '2099-01-01T00:00:00Z' } };
}

it('follows cursor pagination without a page parameter', async (t) => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(url);
    const parsed = new URL(url);
    if (parsed.searchParams.has('page')) return Response.json({ message: 'page is not allowed' }, { status: 400 });
    if (parsed.searchParams.has('cursor')) {
      assert.equal(parsed.searchParams.has('limit'), false);
      assert.equal(parsed.searchParams.get('cursor'), 'opaque+cursor=');
      return Response.json({ entities: [{ id: 2 }], current_page: 2, total_pages: 2 });
    }
    return Response.json({ entities: [{ id: 1 }], current_page: 1, total_pages: 2, next_page_url: 'https://api.example.com/api/v4/acme/workflow-states?cursor=opaque%2Bcursor%3D&fields=id,type' });
  });
  assert.deepEqual(await listAll(session(), '/workflow-states?fields=id,type'), [{ id: 1 }, { id: 2 }]);
  assert.equal(urls.length, 2);
});

it('does not interpret a failed comment lookup as no previous warning', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ tag: 'invalid_params' }, { status: 400 }));
  await assert.rejects(alreadyWarned(session(), 123));
});

it('does not return or cache a partial workflow-state list', async (t) => {
  let calls = 0;
  const s = session();
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1
    ? Response.json({ entities: [{ id: 1, type: 'started' }], current_page: 1, total_pages: 2,
      next_page_url: 'https://api.example.com/api/v4/acme/workflow-states?cursor=next&fields=id,type' })
    : Response.json({ message: 'Unavailable' }, { status: 503 }));
  await assert.rejects(startedStateIds(s));
  assert.equal(s.data.has('started-states:v2:workspace'), false);
});

it('uses request timeouts and logs safe endpoint diagnostics', async (t) => {
  const logs = [];
  let signal;
  t.mock.method(console, 'error', (...args) => logs.push(args));
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signal = options.signal;
    return Response.json({ tag: 'invalid_params', message: 'Rejected private-access private-refresh private-client private body', text: 'private body' }, { status: 400 });
  });
  try { await apiJson(session(), 'POST', '/stories/123/comments?fields=id', { text: 'private body' }); } catch {}
  assert.ok(signal instanceof AbortSignal);
  assert.match(JSON.stringify(logs), /invalid_params/);
  assert.doesNotMatch(JSON.stringify(logs), /private-access|private-refresh|private-client|private body/);
});

it('persists and reports OAuth scopes', async (t) => {
  const s = session();
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ access_token: 'token', refresh_token: 'refresh', permission_id: 'guardian', workspace2_id: 'workspace', workspace2_slug: 'acme', scope: 'read comment-write', access_token_expires_at: '2099-01-01T00:00:00Z' });
  });
  const response = await app.request('/oauth/callback?code=test', undefined, { ...s.env, REDIRECT_URI: 'https://agent.example/callback' });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(await s.kv.get('creds:workspace')).scopes, ['read', 'comment-write']);
});

for (const next of [
  'https://evil.example/api/v4/acme/workflow-states?cursor=secret',
  '/api/v4/other/workflow-states?cursor=secret',
  '/api/v4/acme/members?cursor=secret',
  'https://user:pass@api.example.com/api/v4/acme/workflow-states?cursor=secret',
  '?cursor=secret#fragment', '?cursor=secret&page=2', '?cursor=secret&limit=100',
  '?cursor=a&cursor=b', '?cursor=secret&fields=description', '?fields=id,type',
]) {
  it(`rejects unsafe next-page URL ${next}`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      return Response.json({ entities: [], current_page: 1, total_pages: 2, next_page_url: next });
    });
    await assert.rejects(listAll(session(), '/workflow-states?fields=id,type'), /next-page/);
    assert.equal(calls, 1);
  });
}

it('restores requested fields for relative cursor URLs and rejects cursor loops', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++;
    const params = new URL(url).searchParams;
    assert.equal(params.get('fields'), 'id,type');
    assert.equal(params.get('limit'), calls === 1 ? '100' : null);
    return Response.json({ entities: [], next_page_url: '?cursor=repeat' });
  });
  await assert.rejects(listAll(session(), '/workflow-states?fields=id,type'), /repeated/);
  assert.equal(calls, 2);
});

for (const envelope of [
  { entities: [], current_page: 1, total_pages: 2 },
  { entities: [], current_page: 2, total_pages: 2 },
  { entities: [], current_page: 1, total_pages: 1, next_page_url: '?cursor=unexpected' },
  { entities: null },
]) {
  it(`rejects incomplete/malformed list ${JSON.stringify(envelope)}`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => Response.json(envelope));
    await assert.rejects(listAll(session(), '/workflow-states?fields=id,type'));
  });
}

it('ignores old partial caches and does not cache an empty lookup', async (t) => {
  const s = session();
  s.data.set('started-states:workspace', '[999]');
  t.mock.method(globalThis, 'fetch', async () => Response.json({ entities: [], current_page: 1, total_pages: 1 }));
  assert.deepEqual(await startedStateIds(s), new Set());
  assert.equal(s.data.has('started-states:v2:workspace'), false);
});

const action = { id: 123, action: 'update', entity_type: 'story', app_url: 'https://app.shortcut.com/acme/story/123',
  changes: [{ attribute: 'workflow_state', adds: [{ id: 2 }], removes: [{ id: 1 }] }] };
const warning = { text: '@ada Stories need a team before being started! Please add a team and start again!', author: { id: 'guardian' }, deleted: false };

function businessFetch(t, { comments = [], commentStatus = 200, lookupStatus = 200, team = null } = {}) {
  const writes = [];
  t.mock.method(globalThis, 'fetch', async (raw, init) => {
    const url = new URL(raw);
    if (init.method !== 'GET') {
      writes.push({ method: init.method, path: url.pathname, body: JSON.parse(init.body) });
      return Response.json({ id: 321 }, { status: init.method === 'POST' ? commentStatus : 200 });
    }
    if (url.pathname.endsWith('/workflow-states')) return Response.json({ entities: [{ id: 2, type: 'started' }] });
    if (url.pathname.endsWith('/comments')) return Response.json({ entities: comments }, { status: lookupStatus });
    if (url.pathname.endsWith('/history')) return Response.json({ changes: [] });
    return Response.json({ team, workflow_state: { id: 2 } });
  });
  return writes;
}

it('leaves comment and workflow untouched when comment lookup fails', async (t) => {
  const writes = businessFetch(t, { lookupStatus: 400 });
  await assert.rejects(guardStory(session(), action, async () => '@ada'));
  assert.deepEqual(writes, []);
});

it('finds its warning on a later comment page', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1
    ? Response.json({ entities: [], current_page: 1, total_pages: 2, next_page_url: '?cursor=next' })
    : Response.json({ entities: [warning], current_page: 2, total_pages: 2 }));
  assert.equal(await alreadyWarned(session(), 123), true);
  assert.equal(calls, 2);
});

it('preserves once-per-story warning suppression', async (t) => {
  const writes = businessFetch(t, { comments: [warning] });
  await guardStory(session(), action, async () => '@ada');
  assert.deepEqual(writes, []);
});

it('ignores deleted, other-author and unrelated comments, then warns before reverting', async (t) => {
  const writes = businessFetch(t, { comments: [
    { ...warning, deleted: true }, { ...warning, author: { id: 'human' } }, { ...warning, text: 'Unrelated' },
  ] });
  await guardStory(session(), action, async () => '@ada');
  assert.deepEqual(writes, [
    { method: 'POST', path: '/api/v4/acme/stories/123/comments', body: { text: warning.text } },
    { method: 'PATCH', path: '/api/v4/acme/stories/123', body: { workflow_state_id: 1 } },
  ]);
});

it('does not revert when posting the warning fails', async (t) => {
  const writes = businessFetch(t, { commentStatus: 403 });
  await guardStory(session(), action, async () => '@ada');
  assert.deepEqual(writes.map((w) => w.method), ['POST']);
});

it('does not revert using a stale workflow diff', async (t) => {
  const writes = businessFetch(t);
  await guardStory(session(), { ...action, changes: [{ attribute: 'workflow_state', adds: [{ id: 999 }], removes: [{ id: 1 }] }] }, async () => '@ada');
  assert.deepEqual(writes.map((w) => w.method), ['POST']);
});

it('health check lists no workspaces, slugs, scopes, or tokens', async () => {
  const s = session();
  s.data.set('creds:workspace', JSON.stringify(s.creds));
  const response = await app.request('/', undefined, s.env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['service', 'status']);
  assert.doesNotMatch(JSON.stringify(body), /acme|workspace|scopes|private-access|private-refresh/);
});

function signed(body, secret = 'signing') {
  return { method: 'POST', body, headers: { 'Payload-Signature': createHmac('sha256', secret).update(body).digest('hex') } };
}

it('rejects unsigned and mis-signed webhooks, with no bypass flag', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { env } = session();
  const body = '{"type":"validation"}';
  assert.equal((await app.request('/webhook', { method: 'POST', body }, env)).status, 401);
  assert.equal((await app.request('/webhook', signed(body, 'wrong'), env)).status, 401);
  assert.equal((await app.request('/webhook', signed(body, 'wrong'), { ...env, DEV: 'true' })).status, 401);
  assert.equal((await app.request('/webhook', signed(body), env)).status, 200);
});

it('refuses webhooks and OAuth until every secret is configured, instead of skipping verification', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('must not call Shortcut without configuration'));
  const { env } = session();
  const body = '{"type":"validation"}';
  for (const key of ['CLIENT_ID', 'CLIENT_SECRET', 'WEBHOOK_SECRET', 'REDIRECT_URI']) {
    const partial = { ...env, [key]: '' };
    assert.equal((await app.request('/webhook', { method: 'POST', body }, partial)).status, 503);
    assert.equal((await app.request('/oauth/callback?code=x', undefined, partial)).status, 503);
  }
  assert.equal((await app.request('/nope', undefined, { ...env, WEBHOOK_SECRET: '' })).status, 404);
});

it('rejects oversized webhook bodies before verifying them', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { env } = session();
  const big = JSON.stringify({ type: 'validation', pad: 'x'.repeat(2 * 1024 * 1024) });
  assert.equal((await app.request('/webhook', signed(big), env)).status, 413);
  const stream = new Request('https://worker/webhook', { method: 'POST', body: big, headers: { 'Payload-Signature': 'ab' } });
  assert.equal((await app.fetch(new Request(stream, { headers: { 'Payload-Signature': 'ab' } }), env)).status, 413);
});

it('encodes the actor member id in the API path and sanitizes display-name fallbacks', async (t) => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => { urls.push(url); return Response.json({ entity: {} }); });
  const s = session();
  const name = await resolveActorMention(s, { member_id: '../stories/123?x=1#y', displayable_name: '[@admin](https://evil.example)  O\'Brien\n<b>' });
  assert.equal(new URL(urls[0]).pathname, '/api/v4/acme/members/..%2Fstories%2F123%3Fx%3D1%23y');
  assert.equal(name, "admin https evil.example O'Brien b");
  assert.equal(await resolveActorMention(s, { displayable_name: '***' }), 'Someone');
  assert.equal(await resolveActorMention(s, {}), 'Someone');
});

it('preserves granted scopes on refresh when omitted and replaces them when explicitly returned', async (t) => {
  const s = session();
  s.creds.scopes = ['read', 'comment-write'];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json({ access_token: 'rotated-token', refresh_token: 'rotated-refresh', access_token_expires_at: '2099-01-01T00:00:00Z', ...(++calls === 1 ? {} : { scope: 'read' }) });
  });
  await refreshCredentials(s);
  assert.deepEqual(s.creds.scopes, ['read', 'comment-write']);
  await refreshCredentials(s);
  assert.deepEqual(s.creds.scopes, ['read']);
  assert.deepEqual(JSON.parse(await s.kv.get('creds:workspace')).scopes, ['read']);
});

it('keeps unknown scopes unknown on refresh for legacy credentials', async (t) => {
  const s = session();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ access_token: 'rotated-token', refresh_token: 'rotated-refresh', access_token_expires_at: '2099-01-01T00:00:00Z' }));
  await refreshCredentials(s);
  assert.equal(s.creds.scopes, undefined);
});

it('uses a 15 second timeout and never logs thrown network error contents', async (t) => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  t.mock.method(AbortSignal, 'timeout', (duration) => { assert.equal(duration, 15_000); return new AbortController().signal; });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('private-access https://example.com/?code=private-code'); });
  await assert.rejects(apiJson(session(), 'GET', '/stories/123?fields=team'), /Network request failed or timed out/);
  assert.doesNotMatch(JSON.stringify(logs), /private-access|private-code|https:/);
});

it('safely logs OAuth rejection without code, state, secrets or raw callback content', async (t) => {
  const logs = [];
  const s = session();
  t.mock.method(console, 'error', (...args) => logs.push(args));
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'invalid_grant', error_description: 'private-code private-state private-client https://agent.example/callback?code=other-secret', untrusted: 'raw-private-body' }, { status: 400 }));
  const response = await app.request('/oauth/callback?code=private-code&state=private-state', undefined, { ...s.env, REDIRECT_URI: 'https://agent.example/callback' });
  assert.equal(response.status, 500);
  const text = JSON.stringify(logs);
  assert.match(text, /invalid_grant/);
  assert.doesNotMatch(text, /private-code|private-state|private-client|other-secret|raw-private-body/);
});

it('does not echo or log provider callback error text', async (t) => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  const response = await app.request('/oauth/callback?error=private-error&error_description=private-description', undefined, session().env);
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text() + JSON.stringify(logs), /private-error|private-description/);
});

it('refreshes once on 401 and uses the rotated token', async (t) => {
  const s = session();
  const tokens = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (new URL(url).pathname.endsWith('/token')) return Response.json({ access_token: 'rotated-token', refresh_token: 'rotated-refresh', access_token_expires_at: '2099-01-01T00:00:00Z', scope: 'read' });
    tokens.push(init.headers.Authorization);
    return tokens.length === 1 ? Response.json({ error: 'invalid_token' }, { status: 401 }) : Response.json({ id: 123 });
  });
  assert.deepEqual(await apiJson(s, 'GET', '/stories/123?fields=id'), { id: 123 });
  assert.deepEqual(tokens, ['Bearer private-access', 'Bearer rotated-token']);
});

it('unwraps v4 single-entity responses while retaining list envelopes', async (t) => {
  const responses = [{ entity: { team: null, workflow_state: { id: 2 } } }, { entities: [{ id: 2 }] }, { entity: null }];
  t.mock.method(globalThis, 'fetch', async () => Response.json(responses.shift()));
  assert.deepEqual(await apiJson(session(), 'GET', '/stories/123?fields=team,workflow_state'), { team: null, workflow_state: { id: 2 } });
  assert.deepEqual(await apiJson(session(), 'GET', '/workflow-states?fields=id'), { entities: [{ id: 2 }] });
  assert.equal(await apiJson(session(), 'GET', '/stories/123?fields=id'), null);
});
