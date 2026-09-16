// Estimate Guardian rule, API contract, and durable recovery regressions.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';
import { build } from 'esbuild';

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
const compiled = await build({ stdin: { contents: source + '\nexport { alreadyWarned, startedStateIds, withRefresh, guardStory, refreshCredentials, resolveActorMention, couldBreachRule };', resolveDir: new URL('../src', import.meta.url).pathname, loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', write: false });
const { alreadyWarned, startedStateIds, withRefresh, guardStory, refreshCredentials, resolveActorMention, couldBreachRule, EstimateGuardianStory, default: app } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text + '\n//# sourceURL=estimate-guardian-test-bundle.mjs').toString('base64')}`);
function session() {
  const data = new Map();
  const kv = { async get(k) { return data.get(k) ?? null; }, async put(k, v) { data.set(k, v); }, async list({ prefix }) { return { keys: [...data.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })) }; } };
  const recovery = { async get() { const value = data.get('recovery'); return value ? structuredClone(value) : undefined; }, async save(record) { data.set('recovery', structuredClone(record)); } };
  return { data, kv, recovery, deliveryId: 'delivery', workspaceId: 'workspace', env: { CLIENT_ID: 'client', CLIENT_SECRET: 'private-client', WEBHOOK_SECRET: 'signing', REDIRECT_URI: 'https://agent.example/callback', SHORTCUT_API_BASE: 'https://api.example.com', TOKENS: kv },
    creds: { token: 'private-access', refreshToken: 'private-refresh', memberId: 'estimate-guardian', slug: 'acme', expiresAt: '2099-01-01T00:00:00Z' } };
}

it('follows cursor pagination without a page parameter', async (t) => {
  const urls = [];
  const s = session();
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    urls.push(url);
    const parsed = new URL(url);
    assert.equal(init.headers.Authorization, 'Bearer private-access');
    assert.equal(parsed.searchParams.get('fields'), 'id,type');
    if (parsed.searchParams.has('page')) return Response.json({ message: 'page is not allowed' }, { status: 400 });
    if (parsed.searchParams.has('cursor')) {
      assert.equal(parsed.searchParams.has('limit'), false);
      assert.equal(parsed.searchParams.get('cursor'), 'opaque+cursor=');
      return Response.json({ entities: [{ id: 2, type: 'started' }], current_page: 2, total_pages: 2 });
    }
    assert.equal(parsed.searchParams.get('limit'), '100');
    return Response.json({ entities: [{ id: 1, type: 'started' }, { id: 3, type: 'done' }], current_page: 1, total_pages: 2, next_page_url: 'https://api.example.com/api/v4/acme/workflow-states?cursor=opaque%2Bcursor%3D&fields=id,type' });
  });
  assert.deepEqual(await startedStateIds(s), new Set([1, 2]));
  assert.equal(urls.length, 2);
  assert.deepEqual(JSON.parse(s.data.get('started-states:v2:workspace')), [1, 2]);
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
  try { await withRefresh(session(), (ws) => ws.createStoryComment(123, { text: 'private body' }, { fields: 'id' })); } catch {}
  assert.ok(signal instanceof AbortSignal);
  assert.match(JSON.stringify(logs), /invalid_params/);
  assert.doesNotMatch(JSON.stringify(logs), /private-access|private-refresh|private-client|private body/);
});

it('persists and reports OAuth scopes', async (t) => {
  const s = session();
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ access_token: 'token', refresh_token: 'refresh', permission_id: 'estimate-guardian', workspace2_id: 'workspace', workspace2_slug: 'acme', scope: 'read comment-write', access_token_expires_at: '2099-01-01T00:00:00Z' });
  });
  const response = await app.request('/oauth/callback?code=test', undefined, { ...s.env, REDIRECT_URI: 'https://agent.example/callback' });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(await s.kv.get('creds:workspace')).scopes, ['read', 'comment-write']);
});

// Unsafe continuation links are refused before a second request is made, so a
// leaked bearer token or a smuggled parameter never leaves the API origin.
const endpoint = 'https://api.example.com/api/v4/acme/workflow-states';
for (const next of [
  'https://evil.example/api/v4/acme/workflow-states?cursor=secret',
  'https://user:pass@api.example.com/api/v4/acme/workflow-states?cursor=secret',
  `${endpoint}?cursor=secret#fragment`, `${endpoint}?cursor=secret&page=2`, `${endpoint}?cursor=secret&limit=100`,
  `${endpoint}?cursor=a&cursor=b`, `${endpoint}?fields=id,type`, '?cursor=secret',
]) {
  it(`rejects unsafe next-page URL ${next}`, async (t) => {
    let calls = 0;
    const s = session();
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      return Response.json({ entities: [{ id: 1, type: 'started' }], current_page: 1, total_pages: 2, next_page_url: next });
    });
    await assert.rejects(startedStateIds(s), /invalid, unsafe, or incomplete/);
    assert.equal(calls, 1);
    assert.equal(s.data.has('started-states:v2:workspace'), false);
  });
}

it('retains requested fields and drops limit on cursor pages, and rejects cursor loops', async (t) => {
  let calls = 0;
  const s = session();
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++;
    const params = new URL(url).searchParams;
    assert.equal(params.get('fields'), 'id,type');
    assert.equal(params.get('limit'), calls === 1 ? '100' : null);
    assert.equal(params.has('page'), false);
    return Response.json({ entities: [{ id: 1, type: 'started' }], next_page_url: `${endpoint}?cursor=repeat&fields=id,type` });
  });
  await assert.rejects(startedStateIds(s), /invalid, unsafe, or incomplete/);
  assert.equal(calls, 2);
  assert.equal(s.data.has('started-states:v2:workspace'), false);
});

for (const envelope of [
  { entities: [{ id: 1, type: 'started' }], current_page: 1, total_pages: 2 },
  { entities: null },
]) {
  it(`rejects incomplete/malformed list ${JSON.stringify(envelope)}`, async (t) => {
    const s = session();
    t.mock.method(globalThis, 'fetch', async () => Response.json(envelope));
    await assert.rejects(startedStateIds(s), /invalid, unsafe, or incomplete/);
    assert.equal(s.data.has('started-states:v2:workspace'), false);
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
const warning = { text: '@ada Stories need an estimate before being started! Please add an estimate and start again!', author: { id: 'estimate-guardian' }, deleted: false };

function businessFetch(t, { comments = [], commentStatus = 200, lookupStatus = 200, estimate = null, team = null, historyChanges = [] } = {}) {
  const writes = [];
  t.mock.method(globalThis, 'fetch', async (raw, init) => {
    const url = new URL(raw);
    if (init.method !== 'GET') {
      writes.push({ method: init.method, path: url.pathname, body: JSON.parse(init.body) });
      return Response.json({ entity: { id: 321 } }, { status: init.method === 'POST' ? commentStatus : 200 });
    }
    if (url.pathname.endsWith('/workflow-states')) return Response.json({ entities: [{ id: 2, type: 'started' }] });
    if (url.pathname.endsWith('/comments')) return Response.json({ entities: comments }, { status: lookupStatus });
    if (url.pathname.endsWith('/history')) return Response.json({ changes: historyChanges });
    return Response.json({ entity: { estimate, team, workflow_state: { id: 2 } } });
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
    ? Response.json({ entities: [], current_page: 1, total_pages: 2, next_page_url: 'https://api.example.com/api/v4/acme/stories/123/comments?cursor=next&fields=text,author,deleted,external_id' })
    : Response.json({ entities: [warning], current_page: 2, total_pages: 2 }));
  assert.equal(await alreadyWarned(session(), 123), true);
  assert.equal(calls, 2);
});

it('preserves once-per-story warning suppression', async (t) => {
  const writes = businessFetch(t, { comments: [warning] });
  await guardStory(session(), action, async () => '@ada');
  assert.deepEqual(writes, []);
});

for (const estimate of [0, 1, 8]) {
  it(`accepts an estimate of ${estimate} even without a Team`, async (t) => {
    const writes = businessFetch(t, { estimate });
    await guardStory(session(), action, async () => '@ada');
    assert.deepEqual(writes, []);
  });
}

it('warns and reverts an unestimated Story even when it has a Team', async (t) => {
  const writes = businessFetch(t, { estimate: null, team: { id: 'team' } });
  await guardStory(session(), action, async () => '@ada');
  assert.deepEqual(writes.map(w => w.method), ['POST', 'PATCH']);
  assert.equal(writes[0].body.text, warning.text);
});

it('ignores an unavailable estimate field instead of treating a malformed Story as unestimated', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ entity: { workflow_state: { id: 2 } } }));
  const s = session();
  await guardStory(s, action, async () => assert.fail('must not warn'));
  assert.equal(await s.recovery.get(), undefined);
});

it('treats a null entity as an unavailable Story rather than an unestimated one', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ entity: null }));
  const s = session();
  await guardStory(s, action, async () => assert.fail('must not warn'));
  assert.equal(await s.recovery.get(), undefined);
});

it('reacts to workflow and estimate changes, not Team-only or unrelated updates', () => {
  assert.equal(couldBreachRule(action), true);
  assert.equal(couldBreachRule({ ...action, changes: [{ attribute: 'estimate', adds: [], removes: [3] }] }), true);
  assert.equal(couldBreachRule({ ...action, changes: [{ attribute: 'team', adds: [], removes: [{ id: 'team' }] }] }), false);
  assert.equal(couldBreachRule({ ...action, changes: [{ attribute: 'name', adds: ['new'], removes: ['old'] }] }), false);
  assert.equal(couldBreachRule({ ...action, changes: [] }), false);
  assert.equal(couldBreachRule({ ...action, changes: undefined }), true);
});

it('does not let a former team-rule warning suppress an estimate warning', async (t) => {
  const writes = businessFetch(t, { comments: [{ ...warning, text: '@ada Stories need a team before being started! Please add a team and start again!' }] });
  await guardStory(session(), action, async () => '@ada');
  assert.deepEqual(writes.map(w => w.method), ['POST', 'PATCH']);
});

it('uses history to revert when an Estimate is removed from an already-started Story', async (t) => {
  const writes = businessFetch(t, { historyChanges: action.changes });
  await guardStory(session(), { ...action, changes: [{ attribute: 'estimate', adds: [], removes: [3] }] }, async () => '@ada');
  assert.deepEqual(writes.map(w => w.method), ['POST', 'PATCH']);
  assert.equal(writes[1].body.workflow_state_id, 1);
});

it('recovers a failed revert without posting a second warning', async (t) => {
  const s = session();
  const comments = [];
  let posts = 0;
  let patches = 0;
  t.mock.method(globalThis, 'fetch', async (raw, init) => {
    const path = new URL(raw).pathname;
    if (init.method === 'POST') {
      posts++;
      comments.push(warning);
      return Response.json({ entity: { id: 321 } });
    }
    if (init.method === 'PATCH') {
      patches++;
      return patches === 1
        ? Response.json({ tag: 'unavailable' }, { status: 503 })
        : Response.json({ entity: { id: 123 } });
    }
    if (path.endsWith('/workflow-states')) return Response.json({ entities: [{ id: 2, type: 'started' }] });
    if (path.endsWith('/comments')) return Response.json({ entities: comments });
    return Response.json({ entity: { estimate: null, workflow_state: { id: 2 } } });
  });
  // A later attempt must resume the incomplete revert even though the remote
  // comment now exists. An ordinary pre-existing warning still suppresses work.
  await guardStory(s, action, async () => '@ada');
  await guardStory(s, action, async () => '@ada');
  assert.equal(posts, 1);
  assert.equal(patches, 2, 'the successful warning must not suppress recovery of its failed revert');
});

it('ignores deleted, other-author and unrelated comments, then warns before reverting', async (t) => {
  const writes = businessFetch(t, { comments: [
    { ...warning, deleted: true }, { ...warning, author: { id: 'human' } }, { ...warning, text: 'Unrelated' },
  ] });
  await guardStory(session(), action, async () => '@ada');
  assert.match(writes[0].body.external_id, /^estimate-guardian:/);
  delete writes[0].body.external_id;
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

it('accepts a full observer envelope and rejects a partial one before acting on it', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => assert.fail('must not call Shortcut for an unconnected workspace'));
  const { env } = session();
  const full = { id: 'delivery', version: 'v2', timestamp: '2026-01-01T00:00:00.000Z', installation_id: 'installation',
    workspace2: { id: 'unconnected', url_slug: 'acme' }, actor: { displayable_name: 'Ada', member_id: 'ada' },
    actions: [{ ...action, global_id: 'v2:s:unconnected:123' }] };
  assert.equal((await app.request('/webhook', signed(JSON.stringify(full)), env)).status, 200);
  const { global_id, ...partialAction } = full.actions[0];
  assert.ok(global_id);
  for (const partial of [{ ...full, actions: [partialAction] }, { ...full, workspace2: undefined }, { ...full, actor: {} }, { actions: full.actions }]) {
    const response = await app.request('/webhook', signed(JSON.stringify(partial)), env);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Invalid payload' });
  }
  assert.equal((await app.request('/webhook', signed('{not json'), env)).status, 400);
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

// The token endpoint always reports the workspace; the library rejects a rotation that omits it.
const rotated = { access_token: 'rotated-token', refresh_token: 'rotated-refresh', access_token_expires_at: '2099-01-01T00:00:00Z',
  permission_id: 'estimate-guardian', workspace2_id: 'workspace', workspace2_slug: 'acme' };

it('preserves granted scopes on refresh when omitted and replaces them when explicitly returned', async (t) => {
  const s = session();
  s.creds.scopes = ['read', 'comment-write'];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json({ ...rotated, ...(++calls === 1 ? {} : { scope: 'read' }) });
  });
  await refreshCredentials(s);
  assert.deepEqual(s.creds.scopes, ['read', 'comment-write']);
  await refreshCredentials(s);
  assert.deepEqual(s.creds.scopes, ['read']);
  assert.deepEqual(JSON.parse(await s.kv.get('creds:workspace')).scopes, ['read']);
});

it('keeps unknown scopes unknown on refresh for legacy credentials', async (t) => {
  const s = session();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ...rotated }));
  await refreshCredentials(s);
  assert.equal(s.creds.token, 'rotated-token');
  assert.equal(s.creds.scopes, undefined);
  assert.equal(JSON.parse(await s.kv.get('creds:workspace')).scopes, undefined);
});

it('never logs thrown network error contents', async (t) => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('private-access https://example.com/?code=private-code'); });
  await assert.rejects(withRefresh(session(), (ws) => ws.getStory(123, { fields: 'estimate' })), /Network request failed or timed out/);
  assert.doesNotMatch(JSON.stringify(logs), /private-access|private-code|https:/);
});

it('aborts a stalled request through the library after 15 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  // Never settles on its own; rejects only once the library aborts the signal it passed.
  let signal;
  const fetched = new Promise((resolve) => {
    t.mock.method(globalThis, 'fetch', (_url, init) => new Promise((_resolve, reject) => {
      ({ signal } = init);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      resolve();
    }));
  });
  const pending = withRefresh(session(), (ws) => ws.getStory(123, { fields: 'estimate' }));
  await fetched;
  t.mock.timers.tick(14_999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signal.aborted, true);
  await assert.rejects(pending, /Network request failed or timed out/);
  assert.match(JSON.stringify(logs), /Network request failed or timed out/);
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
    if (new URL(url).pathname.endsWith('/token')) return Response.json({ ...rotated, scope: 'read' });
    tokens.push(init.headers.Authorization);
    return tokens.length === 1 ? Response.json({ error: 'invalid_token' }, { status: 401 }) : Response.json({ entity: { id: 123 } });
  });
  assert.deepEqual(await withRefresh(s, (ws) => ws.getStory(123, { fields: 'id' })), { entity: { id: 123 } });
  assert.deepEqual(tokens, ['Bearer private-access', 'Bearer rotated-token']);
  assert.equal(JSON.parse(await s.kv.get('creds:workspace')).token, 'rotated-token');
});

it('refreshes only once on a persistent 401 and rejects with the response, never the body', async (t) => {
  const s = session();
  let refreshes = 0;
  let requests = 0;
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (new URL(url).pathname.endsWith('/token')) {
      refreshes++;
      return Response.json({ ...rotated });
    }
    requests++;
    return Response.json({ error: 'invalid_token' }, { status: 401 });
  });
  await assert.rejects(withRefresh(s, (ws) => ws.getStory(123, { fields: 'id' })), (error) => error instanceof Response && error.status === 401);
  assert.equal(refreshes, 1);
  assert.equal(requests, 2);
});

function recoveryFixture(t, { patchFailures = 1, ambiguousPost = false, commitPost = true } = {}) {
  const s = session();
  s.data.set('creds:workspace', JSON.stringify(s.creds));
  const records = new Map();
  const state = { storage: {
    async get(key) { return structuredClone(records.get(key)); },
    async transaction(fn) { return fn({
      async put(key, value) { records.set(key, structuredClone(value)); },
      async setAlarm(time) { records.set('alarm', time); },
      async deleteAlarm() { records.delete('alarm'); },
    }); },
  } };
  const remote = { story: { estimate: null, workflow_state: { id: 2 } }, comments: [], posts: 0, patches: 0, afterPost: null };
  t.mock.method(globalThis, 'fetch', async (raw, init) => {
    const path = new URL(raw).pathname;
    if (init.method === 'POST') {
      assert.equal(records.get('recovery').phase, 'commenting');
      assert.equal(records.get('recovery').attempts, 1);
      assert.ok(records.get('alarm'));
      remote.posts++;
      if (commitPost) remote.comments.push({ ...warning, ...JSON.parse(init.body) });
      remote.afterPost?.();
      if (ambiguousPost) throw new Error('simulated response lost');
      return Response.json({ entity: { id: 321 } });
    }
    if (init.method === 'PATCH') {
      assert.equal(records.get('recovery').phase, 'warned');
      assert.ok(records.get('alarm'));
      remote.patches++;
      return remote.patches <= patchFailures ? Response.json({ tag: 'unavailable' }, { status: 503 })
        : Response.json({ entity: { id: 123 } });
    }
    if (path.endsWith('/workflow-states')) return Response.json({ entities: [{ id: 2, type: 'started' }] });
    if (path.endsWith('/comments')) return Response.json({ entities: remote.comments });
    if (path.includes('/members/')) return Response.json({ entity: { mention_name: 'ada' } });
    return Response.json({ entity: remote.story });
  });
  const coordinator = () => new EstimateGuardianStory(state, s.env);
  const deliver = async (deliveryId = 'delivery') => coordinator().fetch(new Request('https://internal/guard', {
    method: 'POST', body: JSON.stringify({ workspaceId: 'workspace', deliveryId, action, actor: { member_id: 'ada', displayable_name: 'Ada' } }),
  }));
  return { s, records, remote, coordinator, deliver };
}

it('recovers from a persisted alarm after coordinator recreation without another webhook', async (t) => {
  const f = recoveryFixture(t);
  assert.equal((await f.deliver()).status, 200);
  assert.equal(f.records.get('recovery').phase, 'warned');
  assert.ok(f.records.get('alarm'));
  await f.coordinator().alarm();
  assert.equal(f.remote.posts, 1);
  assert.equal(f.remote.patches, 2);
  assert.equal(f.records.get('recovery').outcome, 'reverted');
  assert.equal(f.records.has('alarm'), false);
  await f.coordinator().alarm();
  await f.deliver();
  assert.equal(f.remote.patches, 2);
});

it('caps persisted recovery at the initial attempt plus five retries', async (t) => {
  const f = recoveryFixture(t, { patchFailures: Infinity });
  await f.deliver();
  for (let i = 0; i < 10; i++) await f.coordinator().alarm();
  assert.equal(f.remote.posts, 1);
  assert.equal(f.remote.patches, 6);
  assert.equal(f.records.get('recovery').attempts, 6);
  assert.equal(f.records.get('recovery').outcome, 'exhausted');
  assert.equal(f.records.has('alarm'), false);
  await f.deliver();
  assert.equal(f.remote.patches, 6);
});

for (const change of ['estimate', 'workflow_state']) {
  it(`abandons recovery when the Story's ${change} changed`, async (t) => {
    const f = recoveryFixture(t);
    await f.deliver();
    f.remote.story[change] = change === 'estimate' ? 0 : { id: 999 };
    await f.coordinator().alarm();
    assert.equal(f.remote.posts, 1);
    assert.equal(f.remote.patches, 1);
    assert.equal(f.records.get('recovery').outcome, 'superseded');
    f.remote.story = { estimate: null, workflow_state: { id: 2 } };
    await f.deliver('unrelated-later-delivery');
    assert.equal(f.remote.patches, 1, 'old warning must not authorize an unrelated revert');
  });
}

it('rechecks immediately after posting instead of reverting an already-fixed Story', async (t) => {
  const f = recoveryFixture(t);
  f.remote.afterPost = () => { f.remote.story.estimate = 0; };
  await f.deliver();
  assert.equal(f.remote.posts, 1);
  assert.equal(f.remote.patches, 0);
  assert.equal(f.records.get('recovery').outcome, 'superseded');
});

it('does not repost a confirmed warning deleted during recovery', async (t) => {
  const f = recoveryFixture(t);
  await f.deliver();
  f.remote.comments = [];
  await f.coordinator().alarm();
  await f.deliver();
  assert.equal(f.remote.posts, 1);
  assert.equal(f.remote.patches, 2);
  await f.deliver('new-delivery-after-warning-deletion');
  assert.equal(f.remote.posts, 2, 'a new delivery may rearm once the operation has finished');
});

it('recovers an ambiguous POST only by finding its exact external id and author', async (t) => {
  const f = recoveryFixture(t, { ambiguousPost: true, patchFailures: 0 });
  await f.deliver();
  assert.equal(f.records.get('recovery').phase, 'commenting');
  assert.equal(f.remote.patches, 0);
  await f.coordinator().alarm();
  assert.equal(f.remote.posts, 1);
  assert.equal(f.remote.patches, 1);
  assert.equal(f.records.get('recovery').outcome, 'reverted');
});

it('never reverts or reposts if a failed POST has no matching committed warning', async (t) => {
  const f = recoveryFixture(t, { ambiguousPost: true, commitPost: false });
  await f.deliver();
  f.remote.comments.push(warning); // ordinary old warning is not this operation
  for (let i = 0; i < 7; i++) await f.coordinator().alarm();
  assert.equal(f.remote.posts, 1);
  assert.equal(f.remote.patches, 0);
  assert.equal(f.records.get('recovery').outcome, 'exhausted');
});

it('expires recovery after five minutes even if attempts remain', async (t) => {
  const f = recoveryFixture(t);
  await f.deliver();
  const deadline = f.records.get('recovery').deadline;
  t.mock.method(Date, 'now', () => deadline + 1);
  await f.coordinator().alarm();
  assert.equal(f.remote.patches, 1);
  assert.equal(f.records.get('recovery').outcome, 'exhausted');
  assert.equal(f.records.has('alarm'), false);
});

it('serializes concurrent duplicate deliveries through the same coordinator', async (t) => {
  const f = recoveryFixture(t, { patchFailures: 0 });
  const worker = f.coordinator();
  const send = () => worker.fetch(new Request('https://internal/guard', {
    method: 'POST', body: JSON.stringify({ workspaceId: 'workspace', deliveryId: 'same', action, actor: { member_id: 'ada' } }),
  }));
  await Promise.all([send(), send()]);
  assert.equal(f.remote.posts, 1);
  assert.equal(f.remote.patches, 1);
});

it('stops after a PATCH committed but its response was lost', async (t) => {
  const f = recoveryFixture(t, { patchFailures: Infinity });
  await f.deliver();
  // This is the state seen on the next read when the remote PATCH committed
  // despite the caller seeing a failure/timeout.
  f.remote.story.workflow_state = { id: 1 };
  await f.coordinator().alarm();
  assert.equal(f.remote.posts, 1);
  assert.equal(f.remote.patches, 1);
  assert.equal(f.records.get('recovery').phase, 'finished');
});

it('does not use a pending old warning to revert a different observed move', async (t) => {
  const f = recoveryFixture(t);
  await f.deliver();
  // The state happens to match again, but this is a different move delivery.
  await f.deliver('different-move');
  await f.coordinator().alarm();
  assert.equal(f.remote.patches, 1);
  assert.equal(f.remote.posts, 1);
  assert.equal(f.records.get('recovery').outcome, 'superseded');
});
