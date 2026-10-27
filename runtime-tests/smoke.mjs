import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';

// npm executes this shared harness from the selected demo. All imported test
// tools are its direct, locked dev dependencies, not another demo's installs.
const demo = basename(process.cwd());
assert.ok(['devin-bridge', 'estimate-guardian', 'quote-agent', 'team-cop'].includes(demo), 'Run npm run test:runtime inside a demo');
const require = createRequire(resolve('package.json'));
const { build } = require('esbuild');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const { unstable_readConfig } = require('wrangler');
const config = unstable_readConfig({ config: resolve('wrangler.toml') });

const EVENTUALLY_MS = demo === 'devin-bridge' ? 20_000 : 10_000;

async function eventually(read, predicate, description) {
  const deadline = Date.now() + EVENTUALLY_MS;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await setTimeout(25);
  } while (Date.now() < deadline);
  assert.fail(`${description} did not complete within ${EVENTUALLY_MS / 1_000} seconds: ${JSON.stringify(value)}`);
}

test(`${demo}: actual Cloudflare runtime, mocked upstreams`, { timeout: 45_000 }, async (t) => {
  // A test-only entrypoint also awaits registered waitUntil work. Guardian keeps
  // its real execution context, so failures cannot disappear after HTTP 200.
  const entry = JSON.stringify(config.main);
  // Miniflare's SQL-inspection RPC requires the cloudflare DurableObject base
  // class, while Team Cop uses a plain class. Add only a fixed read-only test
  // endpoint; constructor, storage, fetch processing, and alarms remain real.
  const inspection = demo === 'team-cop' ? `
    import { TeamCop as OriginalTeamCop } from ${entry};
    export class TeamCop extends OriginalTeamCop {
      fetch(request) {
        if (request.url === 'https://smoke.internal/deliveries') {
          return Response.json(this.ctx.storage.sql.exec(
            "SELECT key, status FROM deliveries"
          ).toArray());
        }
        return super.fetch(request);
      }
    }` : '';
  const compiled = await build({
    stdin: { contents: `import app from ${entry}; export * from ${entry};
      ${inspection}
      export default { async fetch(request, env, ctx) {
        const pending = [];
        const context = new Proxy(ctx, { get(target, key) {
          if (key === 'waitUntil') return promise => { pending.push(promise); target.waitUntil(promise); };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }});
        const response = await app.fetch(request, env, context);
        await Promise.all(pending);
        return response;
      }};`, resolveDir: process.cwd(), loader: 'js' },
    bundle: true, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
    external: ['node:*', 'cloudflare:workers'], write: false,
  });
  const sqliteClasses = new Set(config.migrations.flatMap((migration) => migration.new_sqlite_classes ?? []));
  const durableObjects = Object.fromEntries(config.durable_objects.bindings.map((binding) => {
    assert.equal(binding.script_name, undefined, 'Smoke tests require local Durable Object classes');
    return [binding.name, { className: binding.class_name, useSQLite: sqliteClasses.has(binding.class_name) }];
  }));
  // Read binding names/classes/migrations and compatibility flags from the real
  // config. Do not load .dev.vars, dotenv files, account credentials, or remote
  // binding settings: every namespace here is fresh and local to this test.
  const mf = new Miniflare(convertV4MiniflareOptions({
    cf: false,
    workers: [
      { name: config.name, modules: true, script: compiled.outputFiles[0].text,
        compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
        kvNamespaces: config.kv_namespaces.map((binding) => binding.binding), durableObjects,
        bindings: { CLIENT_ID: 'synthetic-client', CLIENT_SECRET: 'synthetic-secret',
          REDIRECT_URI: 'https://agent.test/oauth/callback', WEBHOOK_SECRET: 'synthetic-signing',
          SHORTCUT_API_BASE: 'https://shortcut.mock',
          ...(demo === 'devin-bridge' ? { DEVIN_API_KEY: 'synthetic-devin-key', DEVIN_ORG_ID: 'synthetic-org', DEVIN_API_BASE: 'https://devin.mock', ALLOWED_WORKSPACE_IDS: 'workspace' } : {}) },
        outboundService: 'shortcut-mock' },
      { name: 'shortcut-mock', modules: true, script: await readFile(new URL('upstream.mjs', import.meta.url), 'utf8'),
        compatibilityDate: config.compatibility_date,
        outboundService: () => { throw new Error('The mock must never access the network'); } },
    ],
  }));
  let disposal;
  const dispose = () => (disposal ??= mf.dispose());
  t.after(dispose); // Also tear down workerd if the test deadline is reached.
  try {
    const upstream = await mf.getWorker('shortcut-mock');
    const results = async () => (await upstream.fetch('https://shortcut.mock/results')).json();
    const request = (path, options) => mf.dispatchFetch(`https://agent.test${path}`, options);
    const send = async (payload, signed = true) => {
      const body = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      return request('/webhook', { method: 'POST', body, headers: {
        'Shortcut-Signature': signed ? createHmac('sha256', 'synthetic-signing').update(`${timestamp}.smoke.`).update(body).digest('hex') : '0'.repeat(64),
        'Shortcut-Timestamp': timestamp,
        'Shortcut-Delivery': 'smoke',
      } });
    };
    assert.equal((await request('/')).status, 200);
    assert.equal((await send({ type: 'validation' }, false)).status, 401);
    assert.equal((await send({ type: 'validation' })).status, 200);
    assert.equal((await results()).requests.length, 0, 'Validation must not call Shortcut');

    const connected = await request('/oauth/callback?code=synthetic-code&state=synthetic-state');
    assert.equal(connected.status, 200, await connected.text());
    assert.equal((await results()).requests.filter((item) => item.path.endsWith('/token')).length, 1);

    const envelope = (id) => ({ id, version: 'v2', timestamp: new Date().toISOString(), installation_id: 'installation',
      workspace2: { id: 'workspace', url_slug: 'acme' }, actor: { member_id: 'user', displayable_name: 'Ada', mention_name: 'ada' } });
    const deliver = async (id, properties) => {
      const response = await send({ ...envelope(id), ...properties });
      assert.equal(response.status, demo === 'team-cop' ? 202 : 200, await response.text());
    };
    if (demo === 'devin-bridge') {
      assert.deepEqual((await results()).subscription, { enabled: true }, 'OAuth enables agent sessions');
      const snapshot = (turn) => ({ id: 'sess-1', workspace_id: 'workspace', installation_id: 'installation', agent_member_id: 'agent-member',
        created_by: 'user', entity_type: 'story', entity_id: 123, thread_comment_id: null, status: 'active', turn, version: 1, plan: [], external_urls: [] });
      const prompt = (turn, body) => ({ id: `prompt-${turn}`, workspace_id: 'workspace', session_id: 'sess-1', sequence: turn, turn, author_id: 'user',
        in_reply_to: null, content: { type: 'prompt', body }, signal: null, signal_metadata: null, ephemeral: false, superseded: false, created_at: new Date().toISOString() });
      const event = (id, type, turn, body) => ({ id, version: 'v1', type, workspace_id: 'workspace', installation_id: 'installation',
        session: snapshot(turn), ...(type === 'session.created' ? { prompt_context: { text: 'Story 123: Fix login', truncated: false } } : {}), activity: prompt(turn, body) });
      const answered = (turn) => (state) => state.activities.some((item) => item.turn === turn && item.content.type === 'response');
      const created = event('event-created', 'session.created', 1, 'Please fix the login bug');
      assert.equal((await send(created)).status, 200);
      let state = await eventually(results, answered(1), 'Devin Bridge turn 1 response');
      assert.equal(state.activities[0].key, 'devin-bridge:1:ack');
      assert.match(state.activities.find((item) => item.content.type === 'response').content.body, /Fixed the login bug\./);
      assert.deepEqual(state.session.external_urls, [{ label: 'Open in Devin', url: 'https://app.devin.ai/sessions/1' }]);
      assert.equal((await send(created)).status, 200);
      assert.equal((await results()).devin.sessions.length, 1, 'A redelivered event creates no second Devin session');

      await upstream.fetch('https://shortcut.mock/advance-turn', { method: 'POST' });
      assert.equal((await send(event('event-prompted', 'session.prompted', 2, 'Also fix Firefox'))).status, 200);
      state = await eventually(results, answered(2), 'Devin Bridge turn 2 response');
      assert.match(state.activities.find((item) => item.turn === 2 && item.content.type === 'response').content.body, /Fixed Firefox too\./);
      assert.deepEqual(state.devin.received, ['Also fix Firefox']);
      assert.equal(state.devin.sessions.length, 1, 'The follow-up goes to the same Devin session');
    } else if (demo === 'estimate-guardian') {
      await deliver('zero-estimate', { actions: [{ action: 'update', entity_type: 'story', id: 124, global_id: 'v2:s:workspace:124',
        changes: [{ attribute: 'workflow_state', adds: [{ id: 2 }], removes: [{ id: 1 }] }] }] });
      assert.equal((await results()).posts.length, 0, 'A zero-point Estimate must not trigger a warning');
      assert.equal((await results()).patches.length, 0, 'A zero-point Estimate must not trigger a revert');
      const properties = { actions: [{ action: 'update', entity_type: 'story', id: 123, global_id: 'v2:s:workspace:123',
        changes: [{ attribute: 'workflow_state', adds: [{ id: 2 }], removes: [{ id: 1 }] }] }] };
      await deliver('started', properties);
      const first = await results();
      assert.equal(first.posts.length, 1);
      assert.match(first.posts[0].text, /@ada Stories need an estimate before being started!/);
      assert.deepEqual(first.patches, [{ workflow_state_id: 1 }]);
      const firstComment = first.requests.findIndex((item) => item.method === 'POST' && item.path.endsWith('/comments'));
      const firstRevert = first.requests.findIndex((item) => item.method === 'PATCH');
      assert.ok(firstComment >= 0 && firstComment < firstRevert, 'Comment must precede revert');
      await deliver('started-again', properties);
      const second = await results();
      assert.equal(second.posts.length, 1, 'Existing warning suppresses another comment');
      assert.equal(second.patches.length, 1, 'Existing warning suppresses another revert');
      assert.equal(second.requests.filter((item) => item.query.includes('cursor=')).length, 2);
    } else if (demo === 'quote-agent') {
      const assigned = { trigger: { type: 'assigned', entity_type: 'story', entity_id: '123' } };
      await Promise.all([deliver('assigned', assigned), deliver('assigned', assigned)]);
      assert.equal((await results()).posts.length, 1, 'Concurrent duplicate must post once');
      // Evict the real SQLite object: its receipt must survive recreation.
      await mf.unsafeEvictDurableObject(config.name, 'QuoteDeliveries', { name: 'workspace' });
      await deliver('assigned', assigned);
      assert.equal((await results()).posts.length, 1);
      await deliver('new-assignment', assigned);
      await deliver('story-mention', { trigger: { type: 'mentioned', entity_type: 'story', entity_id: '123',
        context: 'comment', comment_id: '44', comment_parent_id: '22' } });
      await deliver('epic-reply', { trigger: { type: 'comment-reply', entity_type: 'epic', entity_id: '456',
        comment_id: '88', parent_comment_id: '77' } });
      const posted = (await results()).posts;
      assert.equal(posted.length, 4);
      assert.equal(posted[2].parent_comment_id, 22);
      assert.equal(posted[3].path, '/api/v4/acme/epics/456/comments');
      assert.equal(posted[3].parent_comment_id, 77);
      assert.equal(new Set(posted.map((post) => post.external_id)).size, 4);
    } else {
      const namespace = await mf.getDurableObjectNamespace('TEAM_COP', config.name);
      const coordinator = namespace.get(namespace.idFromName('team-cop'));
      const records = async () => (await coordinator.fetch('https://smoke.internal/deliveries')).json();
      const completion = async (id) => eventually(
        records,
        (rows) => rows.some((row) => row.key === `installation:${id}` && row.status === 'complete'),
        `Team Cop alarm completion for ${id}`,
      );
      const created = { actions: [{ action: 'create', entity_type: 'story', id: 123, global_id: 'v2:s:workspace:123' }] };
      await deliver('created', created);
      await completion('created');
      let posted = (await results()).posts;
      assert.equal(posted.length, 1);
      assert.equal(posted[0].text, '@ada Stories need to be in a Team! Please add one!');
      await mf.unsafeEvictDurableObject(config.name, 'TeamCop', { name: 'team-cop' });
      await deliver('created', created);
      await completion('created');
      // A distinct event must read the existing comment instead of posting again.
      await deliver('started', { actions: [{ action: 'update', entity_type: 'story', id: 123, global_id: 'v2:s:workspace:123',
        changes: [{ attribute: 'started', adds: [true], removes: [false] }] }] });
      await completion('started');
      const state = await results();
      assert.equal(state.posts.length, 1);
      assert.equal(state.requests.filter((item) => item.query.includes('cursor=')).length, 2);
      assert.ok((await records()).every((row) => row.status === 'complete'));
    }
    assert.deepEqual((await results()).unexpected, [], 'Every Shortcut request must satisfy the mock contract');
  } finally {
    await dispose();
  }
});
