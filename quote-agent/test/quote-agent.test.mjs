import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';
import { build } from 'esbuild';

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
const compiled = await build({ stdin: { contents: source, resolveDir: new URL('../src', import.meta.url).pathname, loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', external: ['cloudflare:workers'], write: false });
const mod = await import(`data:text/javascript;base64,${Buffer.from(`${compiled.outputFiles[0].text}\n//# sourceURL=quote-agent-test-bundle.mjs`).toString('base64')}`);

function harness() {
  const data = new Map([['creds:workspace', JSON.stringify({ token: 'private-access', refreshToken: 'private-refresh', memberId: 'quote', slug: 'acme', expiresAt: '2099-01-01T00:00:00Z' })]]);
  const records = new Map();
  const env = { CLIENT_ID: 'client', CLIENT_SECRET: 'private-client', WEBHOOK_SECRET: 'signing', REDIRECT_URI: 'https://agent.example/callback', SHORTCUT_API_BASE: 'https://api.example.com',
    TOKENS: { async get(k) { return data.get(k) ?? null; }, async put(k, v) { data.set(k, v); }, async list() { return { keys: [...data.keys()].map(name => ({ name })) }; } } };
  const restartCoordinator = () => {
    const object = new mod.QuoteDeliveries({ storage: { async get(k) { return records.get(k); }, async put(k,v) { records.set(k,v); } } }, env);
    env.QUOTE_DELIVERIES = { idFromName: name => name, get: () => object };
  };
  restartCoordinator();
  const deliver = (id = 'delivery', overrides = {}) => {
    const payload = { id, version: 'v2', installation_id: 'install', workspace2: { id: 'workspace', url_slug: 'acme' }, actor: { member_id: 'user' }, trigger: { type: 'assigned', entity_type: 'story', entity_id: '123' }, ...overrides };
    const body = JSON.stringify(payload);
    return mod.default.request('/webhook', { method: 'POST', body, headers: { 'Payload-Signature': createHmac('sha256', 'signing').update(body).digest('hex') } }, env);
  };
  return { env, data, records, deliver, restartCoordinator };
}

it('posts only once for duplicate delivery but responds to a new interaction', async (t) => {
  let posts = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => options.method === 'POST'
    ? (posts++, Response.json({ entity: { id: posts } }))
    : Response.json({ entities: [], current_page: 1, total_pages: 0 }));
  const h = harness();
  assert.equal((await h.deliver()).status, 200);
  assert.equal((await h.deliver()).status, 200);
  assert.equal(posts, 1);
  assert.equal((await h.deliver('another-delivery')).status, 200);
  assert.equal(posts, 2);
});

it('serializes concurrent redelivery', async (t) => {
  let posts = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => options.method === 'POST'
    ? (posts++, Response.json({ entity: { id: posts } }))
    : Response.json({ entities: [], current_page: 1, total_pages: 0 }));
  const h = harness();
  await Promise.all([h.deliver(), h.deliver()]);
  assert.equal(posts, 1);
});

it('retains completed receipts after coordinator recreation and still handles new interactions', async (t) => {
  let posts = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => options.method === 'POST'
    ? (posts++, Response.json({ entity: { id: posts } }))
    : Response.json({ entities: [], current_page: 1, total_pages: 0 }));
  const h = harness();
  assert.equal((await h.deliver()).status, 200);
  assert.equal(posts, 1);
  h.restartCoordinator();
  assert.equal((await h.deliver()).status, 200);
  assert.equal(posts, 1);
  assert.equal((await h.deliver('new-interaction-after-restart')).status, 200);
  assert.equal(posts, 2);
});

it('does not acknowledge or deduplicate failed posts and logs safe errors', async (t) => {
  let failing = true;
  let posts = 0;
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    if (options.method !== 'POST') return Response.json({ entities: [], current_page: 1, total_pages: 0 });
    posts++;
    return failing ? Response.json({ tag: 'invalid_params', message: 'Rejected private-access private-refresh private-client' }, { status: 400 }) : Response.json({ entity: { id: 1 } });
  });
  const h = harness();
  assert.ok((await h.deliver()).status >= 500);
  failing = false;
  assert.equal((await h.deliver()).status, 200);
  assert.equal(posts, 2);
  assert.match(JSON.stringify(logs), /invalid_params/);
  assert.doesNotMatch(JSON.stringify(logs), /private-access|private-refresh|private-client/);
});

it('persists OAuth scopes without logging the returned state', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args));
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ access_token: 'token', refresh_token: 'refresh', permission_id: 'quote', workspace2_id: 'workspace', workspace2_slug: 'acme', scope: 'read comment-write', access_token_expires_at: '2099-01-01T00:00:00Z' });
  });
  const h = harness();
  const response = await mod.default.request('/oauth/callback?code=test&state=private-state', undefined, h.env);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(await h.env.TOKENS.get('creds:workspace')).scopes, ['read', 'comment-write']);
  assert.doesNotMatch(JSON.stringify(logs), /private-state/);
});

it('recovers a post-before-receipt interruption from current comments across cursor pages', async (t) => {
  let marker;
  let posts = 0;
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const parsed = new URL(url);
    requests.push(parsed);
    if (options.method === 'POST') {
      marker = JSON.parse(options.body).external_id;
      posts++;
      return Response.json({ entity: { id: 1 } });
    }
    if (!marker) return Response.json({ entities: [], current_page: 1, total_pages: 0 });
    if (parsed.searchParams.has('cursor')) return Response.json({ entities: [{ id: 1, external_id: marker, author: { id: 'quote' } }], current_page: 2, total_pages: 2 });
    return Response.json({ entities: [], current_page: 1, total_pages: 2, next_page_url: `${parsed.pathname}?cursor=next` });
  });
  const h = harness();
  await h.deliver();
  h.records.clear(); // simulate a lost receipt after the API accepted the comment
  await h.deliver();
  assert.equal(posts, 1);
  const next = requests.find((url) => url.searchParams.has('cursor'));
  assert.equal(next.searchParams.get('fields'), 'id,external_id,author');
  assert.equal(next.searchParams.has('limit'), false);
  assert.equal(next.searchParams.has('page'), false);
});

for (const entityType of ['story', 'epic']) {
  it(`preserves ${entityType} threading and ignores other authors/deleted marker comments`, async (t) => {
    let marker;
    const bodies = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.match(new URL(url).pathname, new RegExp(`/${entityType === 'story' ? 'stories' : 'epics'}/123/comments$`));
      if (options.method === 'POST') {
        const body = JSON.parse(options.body);
        bodies.push(body);
        marker = body.external_id;
        assert.equal(new URL(url).searchParams.get('fields'), 'id');
        return Response.json({ entity: { id: 1 } });
      }
      return Response.json({ entities: marker ? [
        { id: 1, external_id: marker, author: { id: 'human' } },
        { id: null, external_id: marker, author: { id: 'quote' } },
      ] : [], current_page: 1, total_pages: 1 });
    });
    const h = harness();
    const trigger = { type: 'mentioned', entity_type: entityType, entity_id: '123', context: 'comment', comment_id: '456', comment_parent_id: '789' };
    await h.deliver('delivery', { trigger });
    h.records.clear();
    await h.deliver('delivery', { trigger });
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].parent_comment_id, 789);
    assert.equal(bodies[0].external_id, bodies[1].external_id);
    await h.deliver('reply', { trigger: { type: 'comment-reply', entity_type: entityType, entity_id: '123', comment_id: '222', parent_comment_id: '333' } });
    assert.equal(bodies[2].parent_comment_id, 333);
    await h.deliver('top-level-mention', { trigger: { ...trigger, comment_parent_id: undefined } });
    assert.equal(bodies[3].parent_comment_id, 456);
  });
}

for (const next of [
  'https://evil.example/comments?cursor=secret',
  '/api/v4/acme/stories/999/comments?cursor=secret',
  '/api/v4/acme/stories/123/comments?cursor=secret&limit=100',
  '/api/v4/acme/stories/123/comments?cursor=secret#fragment',
  null,
]) {
  it(`fails closed on unsafe/incomplete pagination: ${next}`, async (t) => {
    let calls = 0;
    t.mock.method(console, 'error', () => {});
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      calls++;
      assert.notEqual(options.method, 'POST');
      return Response.json({ entities: [], current_page: 1, total_pages: 2, next_page_url: next });
    });
    const h = harness();
    assert.equal((await h.deliver()).status, 503);
    assert.equal(calls, 1);
    assert.equal(h.records.size, 0);
  });
}

it('rejects repeated cursors and malformed lists without posting or caching success', async (t) => {
  let calls = 0;
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++;
    assert.notEqual(options.method, 'POST');
    return Response.json({ entities: [], current_page: calls, total_pages: 3, next_page_url: '?cursor=repeat' });
  });
  const h = harness();
  assert.equal((await h.deliver()).status, 503);
  assert.equal(calls, 2);
  assert.equal(h.records.size, 0);
});

it('refreshes once on 401, preserves missing refresh scopes, and reports unknown legacy scopes', async (t) => {
  let gets = 0;
  let refreshes = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    if (new URL(url).pathname.includes('oauth-authorization')) {
      refreshes++;
      return Response.json({ access_token: 'renewed-access', refresh_token: 'renewed-refresh', access_token_expires_at: '2099-01-01T00:00:00Z' });
    }
    if (options.method === 'POST') {
      assert.equal(options.headers.Authorization, 'Bearer renewed-access');
      return Response.json({ entity: { id: 1 } });
    }
    gets++;
    return gets === 1 ? Response.json({ error: 'expired' }, { status: 401 }) : Response.json({ entities: [], current_page: 1, total_pages: 0 });
  });
  const h = harness();
  let response = await mod.default.request('/', undefined, h.env);
  assert.equal((await response.json()).credentials[0].scopes, 'unknown');
  const creds = JSON.parse(h.data.get('creds:workspace'));
  h.data.set('creds:workspace', JSON.stringify({ ...creds, scopes: ['read', 'write'] }));
  assert.equal((await h.deliver()).status, 200);
  assert.equal(refreshes, 1);
  assert.deepEqual(JSON.parse(h.data.get('creds:workspace')).scopes, ['read', 'write']);
});

it('sanitizes OAuth rejection, transport errors, and HTML without reflecting state or secrets', async (t) => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('private-access private-refresh private-client private-code private-state'); });
  const h = harness();
  assert.equal((await h.deliver()).status, 503);
  const response = await mod.default.request('/oauth/callback?error=private-code&error_description=%3Cscript%3Eprivate-state%3C/script%3E', undefined, h.env);
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /private-code|private-state|<script>/);
  assert.doesNotMatch(JSON.stringify(logs), /private-access|private-refresh|private-client|private-code|private-state/);
});

it('does not post without OAuth or for self-triggered interactions', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('should not call the API'); });
  const h = harness();
  assert.equal((await h.deliver('self', { actor: { member_id: 'quote' } })).status, 200);
  h.data.clear();
  assert.equal((await h.deliver()).status, 503);
  assert.equal(h.records.size, 0);
});
