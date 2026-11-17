import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHORTCUT = 'https://api.example.com';
export const SID = 'sess-1';
/** The prompt and the context of the mock's `session.created`. */
export const REQUEST = 'Please fix the Safari login bug (private-prompt)';
export const CONTEXT = 'Story 123: Fix login\n\nRequested in comment:\nplease fix (private-prompt)\n\nLogin fails on Safari.';

/** What a backend should be told to open the mock's session: what the user asked, the story link, and Shortcut's context, once each. */
export const openingText = (asked = REQUEST, context = CONTEXT) =>
  [asked ? `A Shortcut user asked:\n\n${asked}` : 'Work on this Shortcut story.', 'Shortcut story: https://app.shortcut.com/acme/story/123', ...(context ? [`Context from Shortcut:\n\n${context}`] : [])].join('\n\n');

const clone = (value) => value === undefined ? undefined : structuredClone(value);
export const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function fakeStorage() {
  const data = new Map();
  let alarm = null;
  return {
    data,
    async get(key) { return clone(data.get(key)); },
    async put(key, value) {
      if (typeof key === 'object') for (const [k, v] of Object.entries(key)) data.set(k, clone(v));
      else data.set(key, clone(value));
    },
    async delete(keys) {
      if ([keys].flat().length > 128) throw new Error('delete() takes at most 128 keys');
      for (const key of [keys].flat()) data.delete(key);
    },
    async list({ prefix = '' } = {}) {
      return new Map([...data].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, clone(v)]));
    },
    async setAlarm(at) { alarm = Number(at); },
    async getAlarm() { return alarm; },
    async deleteAlarm() { alarm = null; },
  };
}

function fakeNamespace(Class, env) {
  const storages = new Map();
  const instances = new Map();
  return {
    storages,
    idFromName: (name) => name,
    get(id) {
      if (!storages.has(id)) storages.set(id, fakeStorage());
      if (!instances.has(id)) instances.set(id, new Class({ id: { name: id, toString: () => `hex-${id}` }, storage: storages.get(id) }, env));
      return instances.get(id);
    },
    restart() { instances.clear(); },
  };
}

function mockShortcut(log) {
  const sessions = new Map();
  const state = { valid: 'token-1', issued: 0, refreshes: 0, subscription: null, subscriptionStatus: 200, rateLimits: [], readRateLimits: [], readFailures: [], serverErrors: 0, rejections: [], patchConflicts: 0, refreshFailure: null, workspaceId: 'workspace' };
  let ids = 0;
  const context = { text: CONTEXT, truncated: false, comment_text: 'please fix (private-prompt)' };

  const snapshot = (s) => ({ id: s.id, workspace_id: 'workspace', installation_id: 'install', agent_member_id: 'bridge-member', created_by: 'ada',
    entity_type: 'story', entity_id: 123, thread_comment_id: null, status: s.status, turn: s.turn, version: s.version, plan: [], external_urls: clone(s.external_urls),
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', last_agent_activity_at: null, first_delivery_at: null, last_delivery_failed_at: null,
    last_delivery_error: null, acknowledged_at: null, stop_requested_at: s.stopRequested ? '2026-10-01T00:00:00Z' : null, closed_reason: s.closed_reason ?? null });
  const prompt = (s, body, signal = null) => ({ id: `prompt-${++ids}`, workspace_id: 'workspace', session_id: s.id, sequence: ids, turn: s.turn, author_id: 'ada',
    in_reply_to: null, content: typeof body === 'string' ? { type: 'prompt', body } : body, signal, signal_metadata: null, ephemeral: false, superseded: false, created_at: '2026-10-01T00:00:00Z' });
  const event = (type, s, activity) => ({ id: `event-${++ids}`, version: 'v1', type, workspace_id: 'workspace', installation_id: 'install',
    session: snapshot(s), ...(type === 'session.created' ? { prompt_context: context } : {}), ...(activity ? { activity } : {}) });

  function append(s, body) {
    const { idempotency_key: key, turn, content, ephemeral } = body;
    if (typeof key !== 'string' || key.length < 1 || key.length > 256) return json({ message: 'Invalid key.' }, 422);
    if (typeof content?.body !== 'string' || content.body.length < 1 || content.body.length > 32768) return json({ message: 'Invalid body.' }, 422);
    if (ephemeral && !['thought', 'action'].includes(content.type)) return json({ message: 'Only progress may be ephemeral.' }, 422);
    const existing = s.activities.find((a) => a.key === key);
    if (existing) {
      const same = JSON.stringify([existing.turn, existing.content, existing.ephemeral ?? false]) === JSON.stringify([turn, content, ephemeral ?? false]);
      return same ? json(existing, 201) : json({ message: 'Idempotency key reused with different content.' }, 409);
    }
    if (turn !== s.turn) return json({ message: 'Activity belongs to an outdated turn.' }, 409);
    if (s.stopRequested && !['response', 'error'].includes(content.type)) return json({ message: 'Stop requested; only a final response or error is accepted.' }, 409);
    if (s.outcome) return json({ message: 'A completed turn requires a new human prompt.' }, 409);
    const activity = { key, turn, content, ...(ephemeral ? { ephemeral: true } : {}) };
    s.activities.push(activity);
    s.lastAgentAt = Date.now();
    if (content.type === 'response' || content.type === 'error') { s.outcome = content.type; s.stopRequested = false; }
    s.status = { thought: 'active', elicitation: 'awaiting_input', response: 'complete', error: 'error' }[content.type];
    return json(activity, 201);
  }

  return {
    state,
    sessions,
    open(id = SID, { body = REQUEST, external_urls = [], version = 1 } = {}) {
      const s = { id, turn: 1, version, status: 'pending', external_urls, stopRequested: false, outcome: null, closed: false, activities: [] };
      sessions.set(id, s);
      return event('session.created', s, prompt(s, body));
    },
    prompt(id, body) {
      const s = sessions.get(id);
      Object.assign(s, { turn: s.turn + 1, outcome: null, stopRequested: false, status: 'active' });
      return event('session.prompted', s, prompt(s, body));
    },
    stop(id) {
      const s = sessions.get(id);
      s.stopRequested = true;
      return event('session.prompted', s, prompt(s, 'Stop', 'stop'));
    },
    // Shortcut's housekeeping: an active session with no agent activity for 30 minutes goes stale.
    sweep(id = SID) {
      const s = sessions.get(id);
      if (s.status === 'active' && Date.now() - (s.lastAgentAt ?? 0) >= 30 * 60_000) s.status = 'stale';
    },
    failTurn(id) {
      const s = sessions.get(id);
      Object.assign(s, { outcome: 'error', status: 'error' });
      s.activities.push({ key: 'shortcut:stale', turn: s.turn, content: { type: 'error', body: 'The agent stopped responding. Please try again.' } });
    },
    activities: (id = SID) => sessions.get(id).activities.filter((a) => !a.key.startsWith('shortcut:')),
    async handle(url, init) {
      const method = (init.method ?? 'GET').toUpperCase();
      const text = init.body == null ? '' : String(init.body);
      log.push({ origin: 'shortcut', method, path: url.pathname, body: text });
      if (url.pathname === '/oauth-authorization-code-flow/token' && method === 'POST') {
        const form = new URLSearchParams(text);
        if (form.get('grant_type') === 'refresh_token') {
          state.refreshes++;
          if (state.refreshFailure) return json({ error: state.refreshFailure.error }, state.refreshFailure.status);
        }
        const n = ++state.issued;
        return json({ access_token: `token-${n}`, refresh_token: `refresh-${n}`, access_token_expires_at: '2099-01-01T00:00:00Z', workspace2_id: state.workspaceId,
          workspace2_slug: 'acme', permission_id: 'bridge-member', scope: 'read write' });
      }
      if (new Headers(init.headers).get('Authorization') !== `Bearer ${state.valid}`) return json({ message: 'Unauthorized' }, 401);
      if (url.search) return json({ message: 'Unexpected query' }, 400);
      if (url.pathname === '/api/v4/acme/agent-sessions/subscription' && method === 'PUT') {
        if (state.subscriptionStatus !== 200) return json({ message: 'private-subscription-detail' }, state.subscriptionStatus);
        state.subscription = JSON.parse(text);
        return json({ workspace_id: 'workspace', installation_id: 'install', enabled: true, enabled_at: '2026-10-01T00:00:00Z', enabled_after_t: 1 });
      }
      const match = url.pathname.match(/^\/api\/v4\/acme\/agent-sessions\/([^/]+)(\/activities)?$/);
      const s = match && sessions.get(decodeURIComponent(match[1]));
      if (!s || s.closed) return json({ message: 'Agent session not found.' }, 404);
      if (method !== 'GET' && state.serverErrors > 0) {
        state.serverErrors--;
        return json({ message: 'Unavailable.' }, 503);
      }
      if (match[2] && method === 'POST' && state.rejections.length) return json({ message: 'private-rejection-detail' }, state.rejections.shift());
      if (method !== 'GET' && state.rateLimits.length) {
        const retryAfter = state.rateLimits.shift();
        return json({ message: 'Too many requests.' }, 429, retryAfter == null ? {} : { 'Retry-After': retryAfter });
      }
      if (match[2] && method === 'POST') return append(s, JSON.parse(text));
      if (match[2]) return json({ message: 'Unexpected method' }, 405);
      if (method === 'GET' && state.readRateLimits.length) return json({ message: 'Too many requests.' }, 429, { 'Retry-After': state.readRateLimits.shift() });
      if (method === 'GET' && state.readFailures.length) return json({ message: 'private-read-detail' }, state.readFailures.shift());
      if (method === 'GET') return json(snapshot(s));
      if (method !== 'PATCH') return json({ message: 'Unexpected method' }, 405);
      const body = JSON.parse(text);
      if (state.patchConflicts > 0) {
        state.patchConflicts--;
        s.version++;
        return json({ message: 'Session has changed; reload before updating.' }, 409);
      }
      if (body.version !== s.version) return json({ message: 'Session has changed; reload before updating.' }, 409);
      const urls = body.external_urls;
      if (!Array.isArray(urls) || urls.length > 20 || new Set(urls.map((u) => u.url)).size !== urls.length || urls.some((u) => !u.label || u.label.length > 128)) {
        return json({ message: 'Invalid links.' }, 422);
      }
      s.external_urls = urls;
      s.version++;
      return json(snapshot(s));
    },
  };
}

const clocks = new WeakSet();

// This file sits outside every demo, so esbuild comes from the bridge at `root`.
// `backend` is a module that takes the place of the bridge's src/backend.ts.
// The bundle then also exports it as `backend`, and the core's `BackendError`,
// which a stand-in outside the demo cannot import.
export async function bridgeHarness({ root, secrets, sensitive, vendor, backend = null }) {
  const { build } = createRequire(new URL('package.json', root))('esbuild');
  const index = await readFile(new URL('src/index.ts', root), 'utf8');
  const standIn = backend && fileURLToPath(backend);
  const source = standIn ? `${index}\nexport { BackendError } from './core/port';\nexport * as backend from ${JSON.stringify(standIn)};\n` : index;
  const swap = { name: 'backend', setup: (bundle) => bundle.onResolve({ filter: /^\.\.\/backend$/ }, () => ({ path: standIn })) };
  const compiled = await build({ stdin: { contents: source, resolveDir: fileURLToPath(new URL('src', root)), loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', external: ['cloudflare:workers'], write: false, plugins: standIn ? [swap] : [] });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(`${compiled.outputFiles[0].text}\n//# sourceURL=${basename(fileURLToPath(root))}-test-bundle.mjs`).toString('base64')}`);
  const SECRETS = { CLIENT_ID: 'client', CLIENT_SECRET: 'private-client', WEBHOOK_SECRET: 'private-signing', REDIRECT_URI: 'https://bridge.example/oauth/callback',
    ...secrets, ALLOWED_WORKSPACE_IDS: 'other-workspace, workspace' };

  function setup(t) {
    if (!clocks.has(t)) {
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      clocks.add(t);
    }
    const requests = [];
    const logs = [];
    const shortcut = mockShortcut(requests);
    const backend = vendor.mock(requests);
    for (const level of ['log', 'warn', 'error']) t.mock.method(console, level, (...args) => logs.push([level, ...args]));
    t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === SHORTCUT) return shortcut.handle(url, init);
      if (url.origin === vendor.origin) return backend.handle(url, init);
      throw new Error(`unexpected origin ${url.origin}`);
    });
    const env = { ...SECRETS, SHORTCUT_API_BASE: SHORTCUT, ...vendor.env };
    env.WORKSPACES = fakeNamespace(mod.Workspace, env);
    env.SESSIONS = fakeNamespace(mod.Session, env);
    const signed = (body, secret = SECRETS.WEBHOOK_SECRET) => ({ method: 'POST', body, headers: shortcutHeaders(body, secret) });
    const h = {
      env, shortcut, vendor: backend, requests, logs,
      request: (path, init) => mod.default.request(path, init, env),
      deliver: (payload) => h.request('/webhook', signed(JSON.stringify(payload))),
      signed,
      async connect() {
        const response = await h.request('/oauth/callback?code=private-code&state=private-state');
        assert.equal(response.status, 200, await response.text());
      },
      // The alarm fires at its scheduled time, so the clock moves there first.
      async tick(id = SID) {
        const at = await env.SESSIONS.storages.get(id)?.getAlarm();
        if (at != null && at > Date.now()) t.mock.timers.tick(at - Date.now());
        return env.SESSIONS.get(id).alarm();
      },
      async alarmIn(id = SID) {
        const at = await env.SESSIONS.storages.get(id).getAlarm();
        return at === null ? null : at - Date.now();
      },
      async started() {
        await h.connect();
        assert.equal((await h.deliver(shortcut.open())).status, 200);
        await h.tick();
        return backend.only();
      },
      posts: (pattern) => requests.filter((r) => r.origin === 'shortcut' && r.method === 'POST' && r.path.endsWith('/activities') && pattern.test(JSON.parse(r.body).idempotency_key)),
      assertCleanLogs() { assert.doesNotMatch(JSON.stringify(logs), sensitive); },
    };
    return h;
  }

  return { mod, SECRETS, setup };
}

// Shortcut's headers without the deprecated Payload-Signature, as Shortcut sends them since sc-322342.
export function shortcutHeaders(body, secret, timestamp = String(Math.floor(Date.now() / 1000))) {
  const delivery = JSON.parse(body).id ?? 'test-delivery';
  const signature = createHmac('sha256', secret).update(`${timestamp}.${delivery}.`).update(body).digest('hex');
  return { 'Shortcut-Signature': signature, 'Shortcut-Timestamp': timestamp, 'Shortcut-Delivery': delivery };
}

export function assertAbout(actual, expected, label) {
  assert.ok(actual !== null && actual > expected - 1_500 && actual <= expected + 100, `${label}: expected about ${expected} ms, got ${actual}`);
}
