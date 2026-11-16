import assert from 'node:assert/strict';
import { bridgeHarness, json } from '../../runtime-tests/bridge/harness.mjs';

export { SID, assertAbout, openingText, shortcutHeaders } from '../../runtime-tests/bridge/harness.mjs';

const CLAUDE = 'https://claude.example';
const ANTHROPIC_API_KEY = 'sk-ant-private-claude-key';
export const AGENT = 'agent_bridge';
export const ENVIRONMENT = 'env_bridge';
export const WORKSPACE = 'wrkspc_acme';
export const SENSITIVE = /private|token-\d|refresh-\d|sk-ant/;
export const consoleUrl = (session) => `https://platform.claude.com/workspaces/${WORKSPACE}/sessions/${session.id}`;

const BETA = 'managed-agents-2026-04-01';
const LIST_PARAMS = new Set(['types[]', 'order', 'limit', 'page', 'created_at[gte]']);
const SESSION_FIELDS = new Set(['agent', 'environment_id', 'title', 'metadata']);
const error = (status, message, headers = {}) => json({ type: 'error', error: { type: 'invalid_request_error', message }, request_id: 'req_private' }, status, headers);

// The Managed Agents API as the bridge uses it. The test drives the agent's side.
function mockClaude(log) {
  const sessions = [];
  const failures = [];
  const state = { lose: null, answer: null, lag: false, hideQueued: false, pageSize: null, gone: 409 };
  let ids = 0;
  let clock = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 1) + ++clock * 1000).toISOString();
  // The queryable status can still say `running` after the idle event is in the list.
  const view = (s) => ({ type: 'session', id: s.id, status: state.lag && s.status === 'idle' ? 'running' : s.status, title: s.title, metadata: s.metadata, agent: { type: 'agent', id: AGENT, version: 1 },
    environment_id: ENVIRONMENT, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', archived_at: null, budget: null, resources: [], vault_ids: [] });
  const text = (event) => event.content.map((block) => block.text).join('');
  const append = (s, event, processed = true) => {
    const created = { id: `sevt_${++ids}`, ...event, processed_at: processed ? stamp() : null };
    s.events.push(created);
    return created;
  };
  const idle = (s, stop_reason, stop_details = null) => {
    append(s, { type: 'session.status_idle', stop_reason, stop_details });
    s.status = 'idle';
  };
  // An interrupted turn runs on to a safe boundary. The test says when it gets there.
  const settle = (s) => {
    if (!s.stopping) return;
    s.stopping = false;
    idle(s, { type: 'end_turn' });
  };
  // A turn takes every queued message when it starts. A running turn takes none.
  const run = (s) => {
    settle(s);
    if (s.status === 'running') return;
    for (const event of s.events) if (event.processed_at === null) event.processed_at = stamp();
    append(s, { type: 'session.status_running' });
    s.status = 'running';
  };
  const rest = (s, stop_reason, stop_details = null) => {
    run(s);
    idle(s, stop_reason, stop_details);
  };
  const wait = (s, uses) => {
    s.waiting = uses.map((use) => use.id);
    idle(s, { type: 'requires_action', event_ids: [...s.waiting] });
    return uses;
  };
  // The list is ordered by `processed_at`. A queued event has none, so it sorts last and no time filter matches it.
  function list(s, url) {
    const params = [...url.searchParams.keys()];
    if (params.some((key) => !LIST_PARAMS.has(key))) return error(400, 'Unknown query parameter.');
    const types = url.searchParams.getAll('types[]');
    const since = url.searchParams.get('created_at[gte]');
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 1000), state.pageSize ?? Infinity);
    const offset = Number(url.searchParams.get('page') ?? 0);
    const ordered = s.events.map((event, at) => ({ event, at }))
      .sort((a, b) => (a.event.processed_at ?? '~').localeCompare(b.event.processed_at ?? '~') || a.at - b.at).map(({ event }) => event)
      .filter((event) => (!types.length || types.includes(event.type)) && (event.processed_at !== null || (!state.hideQueued && since === null)))
      .filter((event) => since === null || event.processed_at >= since);
    if (url.searchParams.get('order') === 'desc') ordered.reverse();
    const more = offset + limit < ordered.length;
    return json({ data: ordered.slice(offset, offset + limit), next_page: more ? String(offset + limit) : null });
  }
  function receive(s, event) {
    if (s.status === 'terminated') return error(state.gone, 'The session is terminated.');
    switch (event.type) {
      case 'user.message':
        if (s.waiting.length) return error(400, 'The session is waiting on a tool result.');
        s.received.push(text(event));
        return append(s, { type: 'user.message', content: event.content }, false);
      case 'user.custom_tool_result': {
        const call = event.custom_tool_use_id;
        if (!s.events.some((made) => made.type === 'agent.custom_tool_use' && made.id === call)) return error(400, 'No such tool call.');
        const result = append(s, { type: 'user.custom_tool_result', custom_tool_use_id: call, content: event.content });
        // A second result for a call is accepted and has no effect.
        if (!s.waiting.includes(call)) return result;
        s.waiting = s.waiting.filter((id) => id !== call);
        s.received.push(text(event));
        if (s.waiting.length) idle(s, { type: 'requires_action', event_ids: [...s.waiting] });
        else run(s);
        return result;
      }
      case 'user.interrupt':
        s.interrupts++;
        // It jumps the queue, so messages waiting behind it stay queued. An idle session ignores it.
        if (s.status === 'running') s.stopping = true;
        return { id: '', type: 'user.interrupt', processed_at: s.stopping ? null : stamp() };
      default:
        return error(400, 'Unexpected event type.');
    }
  }

  return {
    sessions,
    state,
    only() { assert.equal(sessions.length, 1, 'exactly one Claude session'); return sessions[0]; },
    work: run,
    say(s, words) {
      run(s);
      append(s, { type: 'agent.message', content: [{ type: 'text', text: words }] });
    },
    /** The agent speaks without starting a turn, as it does while an interrupted turn winds down. */
    mutter(s, words) { append(s, { type: 'agent.message', content: [{ type: 'text', text: words }] }); },
    /** Any event from the agent's side. */
    emit(s, event) { run(s); return append(s, event); },
    finish: (s) => rest(s, { type: 'end_turn' }),
    settle,
    /** The agent makes these custom tool calls in one response and waits for every result. */
    calls(s, made) {
      run(s);
      return wait(s, made.map(([name, input]) => append(s, { type: 'agent.custom_tool_use', name, input })));
    },
    call(s, name, input) { return this.calls(s, [[name, input]])[0]; },
    ask(s, question) { return this.call(s, 'ask_user', { question }); },
    /** Someone other than the bridge answers a call. */
    answer(s, call, words) { return receive(s, { type: 'user.custom_tool_result', custom_tool_use_id: call.id, content: [{ type: 'text', text: words }] }); },
    /** A built-in tool call waits for a `user.tool_confirmation`. */
    confirm(s, name) {
      run(s);
      wait(s, [append(s, { type: 'agent.tool_use', name, input: {}, evaluated_permission: 'ask' })]);
    },
    idle: rest,
    terminate(s) {
      append(s, { type: 'session.status_terminated' });
      s.status = 'terminated';
    },
    /** `status` is an HTTP status, `network` for a fetch that throws, or `stall` for a body that never ends. */
    failNext(status, headers = {}, call = /./) { failures.push({ status, headers, call }); },
    async handle(url, init) {
      const method = (init.method ?? 'GET').toUpperCase();
      const body = init.body == null ? '' : String(init.body);
      log.push({ origin: 'claude', method, path: url.pathname, query: url.search, body });
      const headers = new Headers(init.headers);
      if (headers.get('Authorization') !== `Bearer ${ANTHROPIC_API_KEY}`) return error(401, 'Unauthorized');
      if (!(headers.get('anthropic-beta') ?? '').split(',').includes(BETA)) return error(400, 'Missing beta header.');
      if (failures.length && failures[0].call.test(`${method} ${url.pathname}`)) {
        const { status, headers: extra } = failures.shift();
        if (status === 'network') throw new TypeError('fetch failed: private-claude-detail');
        // As `fetch` does, the body fails when the request's signal aborts.
        if (status === 'stall') return new Response(new ReadableStream({ start: (stream) => init.signal.addEventListener('abort', () => stream.error(init.signal.reason)) }), { headers: { 'Content-Type': 'application/json' } });
        return error(status, 'private-claude-detail', extra);
      }
      // The request took effect. `lose` drops its answer, and `answer` replaces the answer's body.
      const answered = (call, response) => {
        if (state.lose === call) {
          state.lose = null;
          return error(504, 'Gateway timeout');
        }
        if (state.answer?.call !== call) return response;
        const replaced = json(state.answer.body);
        state.answer = null;
        return replaced;
      };
      if (url.pathname === '/v1/sessions' && method === 'POST') {
        const session = JSON.parse(body);
        if (Object.keys(session).some((key) => !SESSION_FIELDS.has(key)) || session.agent !== AGENT || session.environment_id !== ENVIRONMENT ||
            typeof session.title !== 'string' || typeof session.metadata?.shortcut_session !== 'string') return error(400, 'Invalid session.');
        const s = { id: `sesn_${sessions.length + 1}`, status: 'idle', title: session.title, metadata: session.metadata, events: [], received: [], waiting: [], interrupts: 0, stopping: false };
        sessions.push(s);
        return answered('open', json(view(s)));
      }
      const [, id, sub] = url.pathname.match(/^\/v1\/sessions\/([^/]+)(\/events)?$/) ?? [];
      const s = sessions.find((candidate) => candidate.id === decodeURIComponent(id ?? ''));
      if (!s) return error(404, 'Not found.');
      if (!sub && method === 'GET') return json(view(s));
      if (sub && method === 'GET') return list(s, url);
      if (sub && method === 'POST') {
        const { events, ...extra } = JSON.parse(body);
        if (Object.keys(extra).length || !Array.isArray(events) || events.length !== 1) return error(400, 'Send one event.');
        const created = receive(s, events[0]);
        if (created instanceof Response) return created;
        return answered(events[0].type === 'user.interrupt' ? 'halt' : 'send', json({ data: [created] }));
      }
      return error(405, 'Unexpected method.');
    },
  };
}

const bridge = await bridgeHarness({
  root: new URL('..', import.meta.url),
  secrets: { ANTHROPIC_API_KEY, CLAUDE_AGENT_ID: AGENT, CLAUDE_ENVIRONMENT_ID: ENVIRONMENT },
  sensitive: SENSITIVE,
  vendor: { origin: CLAUDE, env: { ANTHROPIC_API_BASE: CLAUDE, CLAUDE_CONSOLE_WORKSPACE_ID: WORKSPACE }, mock: mockClaude },
});
export const { mod, SECRETS } = bridge;

export function setup(t, { linked = true } = {}) {
  const h = bridge.setup(t);
  if (!linked) delete h.env.CLAUDE_CONSOLE_WORKSPACE_ID;
  // The shared harness records log, warn, and error. The SDK can also write to these two.
  for (const level of ['info', 'debug']) t.mock.method(console, level, (...args) => h.logs.push([level, ...args]));
  return Object.assign(h, {
    claude: h.vendor,
    claudeCalls: (method, pattern = /./) => h.requests.filter((r) => r.origin === 'claude' && r.method === method && pattern.test(r.path)),
    sent: () => h.requests.filter((r) => r.origin === 'claude' && r.method === 'POST' && r.path.endsWith('/events')).map((r) => JSON.parse(r.body).events[0]),
  });
}

/** Shortcut's activities of one type, as `[turn, body]`. */
export const typed = (h, type) => h.shortcut.activities().filter((a) => a.content.type === type).map((a) => [a.turn, a.content.body]);

export async function until(h, reached, what) {
  for (let i = 0; i < 40 && !reached(); i++) await h.tick();
  assert.ok(reached(), what);
}

/** The agent says `text` and ends its turn, and the bridge posts it as the response. */
export async function finished(h, session, text) {
  h.claude.say(session, text);
  h.claude.finish(session);
  await until(h, () => typed(h, 'response').some(([, body]) => body.startsWith(text)), `posts "${text}"`);
}
