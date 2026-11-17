import assert from 'node:assert/strict';
import { bridgeHarness, json } from '../../runtime-tests/bridge/harness.mjs';

export { SID, assertAbout, shortcutHeaders } from '../../runtime-tests/bridge/harness.mjs';

const DEVIN = 'https://devin.example';
const DEVIN_API_KEY = 'cog_private-devin-key';
export const SENSITIVE = /private|token-\d|refresh-\d|cog_/;

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
      if (new Headers(init.headers).get('Authorization') !== `Bearer ${DEVIN_API_KEY}`) return json({ title: 'Unauthorized', status: 401 }, 401);
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

const bridge = await bridgeHarness({
  root: new URL('..', import.meta.url),
  secrets: { DEVIN_API_KEY, DEVIN_ORG_ID: 'org-acme' },
  sensitive: SENSITIVE,
  vendor: { origin: DEVIN, env: { DEVIN_API_BASE: DEVIN }, mock: mockDevin },
});
export const { mod, SECRETS } = bridge;

export function setup(t) {
  const h = bridge.setup(t);
  return Object.assign(h, {
    devin: h.vendor,
    devinCalls: (method, pattern = /./) => h.requests.filter((r) => r.origin === 'devin' && r.method === method && pattern.test(r.path)),
  });
}
