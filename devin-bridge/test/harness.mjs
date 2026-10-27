import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
const compiled = await build({ stdin: { contents: source, resolveDir: new URL('../src', import.meta.url).pathname, loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', external: ['cloudflare:workers'], write: false });
export const mod = await import(`data:text/javascript;base64,${Buffer.from(`${compiled.outputFiles[0].text}\n//# sourceURL=devin-bridge-test-bundle.mjs`).toString('base64')}`);

const SHORTCUT = 'https://api.example.com';
const DEVIN = 'https://devin.example';
export const SECRETS = { CLIENT_ID: 'client', CLIENT_SECRET: 'private-client', WEBHOOK_SECRET: 'private-signing', REDIRECT_URI: 'https://bridge.example/oauth/callback',
  DEVIN_API_KEY: 'cog_private-devin-key', DEVIN_ORG_ID: 'org-acme', ALLOWED_WORKSPACE_IDS: 'other-workspace, workspace' };
export const SID = 'sess-1';
export const SENSITIVE = /private|token-\d|refresh-\d|cog_/;

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

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
  const context = { text: 'Story 123: Fix login\n\nRequested in comment:\nplease fix (private-prompt)\n\nLogin fails on Safari.', truncated: false, comment_text: 'please fix (private-prompt)' };

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
    if (content.type === 'response' || content.type === 'error') { s.outcome = content.type; s.stopRequested = false; }
    s.status = { thought: 'active', elicitation: 'awaiting_input', response: 'complete', error: 'error' }[content.type];
    return json(activity, 201);
  }

  return {
    state,
    sessions,
    open(id = SID, { body = 'Please fix the Safari login bug (private-prompt)', external_urls = [], version = 1 } = {}) {
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

function mockDevin(log) {
  const sessions = [];
  const failures = [];
  const state = { cutMessages: false, malformedMessages: false, messagePatch: null, loseCreate: false, loseSend: false, malformedList: false, listPatch: null, extraItems: [], ignoreTagFilter: false };
  let gate = null;
  let ids = 0;
  const view = (s) => ({ session_id: s.id, url: s.url, status: s.status, status_detail: s.status_detail, title: s.title ?? null, tags: s.tags, org_id: 'org-acme',
    created_at: s.created_at ?? 1, updated_at: 1, acus_consumed: 0, pull_requests: s.pull_requests });
  function seed(props = {}) {
    const n = sessions.length + 1;
    const s = { id: `devin-${n}`, url: `https://app.devin.ai/sessions/${n}`, status: 'new', status_detail: null, tags: [], pull_requests: [], messages: [], received: [], ...props };
    sessions.push(s);
    return s;
  }
  return {
    sessions,
    state,
    seed,
    only() { assert.equal(sessions.length, 1, 'exactly one Devin session'); return sessions[0]; },
    say(s, message) { s.messages.push({ event_id: `evt-${++ids}`, source: 'devin', message, created_at: ids }); },
    failNext(status, headers = {}, call = /./) { failures.push({ status, headers, call }); },
    hold() {
      let release, arrive;
      const reached = new Promise((resolve) => { arrive = resolve; });
      gate = { held: new Promise((resolve) => { release = resolve; }), arrive };
      return { release, reached };
    },
    async handle(url, init) {
      const method = (init.method ?? 'GET').toUpperCase();
      const text = init.body == null ? '' : String(init.body);
      log.push({ origin: 'devin', method, path: url.pathname, query: url.search, body: text });
      if (gate) {
        const { held, arrive } = gate;
        gate = null;
        arrive();
        await held;
      }
      if (new Headers(init.headers).get('Authorization') !== `Bearer ${SECRETS.DEVIN_API_KEY}`) return json({ title: 'Unauthorized', status: 401 }, 401);
      if (failures.length && failures[0].call.test(`${method} ${url.pathname}`)) {
        const { status, headers } = failures.shift();
        return json({ title: 'Failure', status, detail: 'private-devin-detail' }, status, headers);
      }
      const prefix = '/v3/organizations/org-acme/sessions';
      if (!url.pathname.startsWith(prefix)) return json({ title: 'Not found', status: 404 }, 404);
      const rest = url.pathname.slice(prefix.length);
      if (rest === '' && method === 'POST') {
        const body = JSON.parse(text);
        const created = view(seed({ prompt: body.prompt, title: body.title, tags: body.tags ?? [] }));
        if (!state.loseCreate) return json(created);
        state.loseCreate = false;
        return json({ title: 'Gateway timeout', status: 504 }, 504);
      }
      if (rest === '' && method === 'GET') {
        if (state.malformedList) return json({ sessions: [] });
        const tags = url.searchParams.getAll('tags');
        const all = state.ignoreTagFilter ? sessions : sessions.filter((s) => tags.every((tag) => s.tags.includes(tag)));
        const first = Number(url.searchParams.get('first'));
        const after = Number(url.searchParams.get('after') ?? 0);
        const more = after + first < all.length;
        const page = { items: [...state.extraItems, ...all.slice(after, after + first).map(view)], end_cursor: more ? String(after + first) : null, has_next_page: more };
        return json({ ...page, ...state.listPatch });
      }
      const [, id, sub] = rest.match(/^\/([^/]+)(\/messages)?$/) ?? [];
      const s = sessions.find((candidate) => candidate.id === decodeURIComponent(id ?? ''));
      if (!s) return json({ title: 'Not found', status: 404 }, 404);
      if (sub && method === 'GET') return json({ items: [...(state.malformedMessages ? [{ bogus: true }] : []), ...s.messages], end_cursor: null, has_next_page: state.cutMessages, ...state.messagePatch });
      if (sub && method === 'POST') {
        const { message } = JSON.parse(text);
        s.received.push(message);
        s.messages.push({ event_id: `evt-${++ids}`, source: 'user', message, created_at: ids });
        if (!state.loseSend) return new Response(null, { status: 204 });
        state.loseSend = false;
        return json({ title: 'Gateway timeout', status: 504 }, 504);
      }
      if (method === 'GET') return json(view(s));
      if (method === 'DELETE') {
        Object.assign(s, { status: 'exit', status_detail: null, terminated: true });
        return new Response(null, { status: 204 });
      }
      return json({ title: 'Unexpected', status: 405 }, 405);
    },
  };
}

const clocks = new WeakSet();

export function setup(t) {
  if (!clocks.has(t)) {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    clocks.add(t);
  }
  const requests = [];
  const logs = [];
  const shortcut = mockShortcut(requests);
  const devin = mockDevin(requests);
  for (const level of ['log', 'warn', 'error']) t.mock.method(console, level, (...args) => logs.push([level, ...args]));
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === SHORTCUT) return shortcut.handle(url, init);
    if (url.origin === DEVIN) return devin.handle(url, init);
    throw new Error(`unexpected origin ${url.origin}`);
  });
  const env = { ...SECRETS, SHORTCUT_API_BASE: SHORTCUT, DEVIN_API_BASE: DEVIN };
  env.WORKSPACES = fakeNamespace(mod.Workspace, env);
  env.SESSIONS = fakeNamespace(mod.Session, env);
  const signed = (body, secret = SECRETS.WEBHOOK_SECRET) => ({ method: 'POST', body, headers: shortcutHeaders(body, secret) });
  const h = {
    env, shortcut, devin, requests, logs,
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
      return devin.only();
    },
    posts: (pattern) => requests.filter((r) => r.origin === 'shortcut' && r.method === 'POST' && r.path.endsWith('/activities') && pattern.test(JSON.parse(r.body).idempotency_key)),
    devinCalls: (method, pattern = /./) => requests.filter((r) => r.origin === 'devin' && r.method === method && pattern.test(r.path)),
    assertCleanLogs() { assert.doesNotMatch(JSON.stringify(logs), SENSITIVE); },
  };
  return h;
}

// Shortcut's headers without the deprecated Payload-Signature, as sc-322342 will send them.
export function shortcutHeaders(body, secret, timestamp = String(Math.floor(Date.now() / 1000))) {
  const delivery = JSON.parse(body).id ?? 'test-delivery';
  const signature = createHmac('sha256', secret).update(`${timestamp}.${delivery}.`).update(body).digest('hex');
  return { 'Shortcut-Signature': signature, 'Shortcut-Timestamp': timestamp, 'Shortcut-Delivery': delivery };
}

export function assertAbout(actual, expected, label) {
  assert.ok(actual !== null && actual > expected - 1_500 && actual <= expected + 100, `${label}: expected about ${expected} ms, got ${actual}`);
}
