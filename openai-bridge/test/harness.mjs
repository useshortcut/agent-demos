import assert from 'node:assert/strict';
import { bridgeHarness, json } from '../../runtime-tests/bridge/harness.mjs';

export { SID, assertAbout, openingText } from '../../runtime-tests/bridge/harness.mjs';

const OPENAI = 'https://openai.example';
const OPENAI_API_KEY = 'sk-private-openai-key';
export const AGENT_ID = 'agent_shortcut';
export const SENSITIVE = /private|token-\d|refresh-\d|sk-/;
const QUERY = new Set(['metadata[shortcut_session]', 'order', 'limit', 'after']);
const ACTIVE = ['queued', 'in_progress', 'waiting'];

// The Agents API as its documentation and SDK describe it. A 202 confirms that
// an input was accepted, not that it was acted on: a message or a function
// result waits in `inbox` until the agent picks it up (`work`), and only then
// shows in the items. A function call stays in `required_actions` until its
// result is picked up. `received` holds every text the agent was sent after
// the create: a message once per idempotency key, a function result each time
// one was accepted, since the key is documented for messages only.
//
// What the documentation leaves open is a knob or an argument, so a test
// picks the order: `work(s, 1)` picks up one input, so the next message runs
// as a turn of its own instead of steering; `listLag` hides a new session
// from the metadata filter; `slowCancel` holds an accepted cancel until
// `settle`. Under `unsteerable` the working turn goes on and the message
// fails; that the message gets a failed turn of its own is this mock's guess.
function mockAgents(log) {
  const sessions = [];
  const failures = [];
  const state = { loseCreate: false, loseSend: false, listLag: 0, ignoreFilter: false, unsteerable: false, itemPatch: null, slowCancel: false };
  let ids = 0;
  const next = (prefix) => `${prefix}_${++ids}`;

  const view = (s) => ({ id: s.id, object: 'agent.session', agent: { id: AGENT_ID, model: 'gpt-6-astra' }, created_at: s.created_at, environment: s.environment,
    error: s.status === 'failed' ? 'private-session-error' : null, last_active_at: s.created_at, metadata: s.metadata, required_actions: s.actions, status: s.status, usage: null, vault_ids: [] });
  const turnView = (s, turn) => ({ id: turn.id, object: 'agent.session.turn', agent_id: AGENT_ID, session_id: s.id, status: turn.status,
    error: turn.code ? { code: turn.code, message: 'private-turn-detail' } : null, created_at: 1, started_at: 1, completed_at: null, subagent_id: null, usage: null });
  const page = (data, more = false) => json({ object: 'list', data, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null, has_more: more });
  const active = (s) => s.turns.findLast((turn) => ACTIVE.includes(turn.status)) ?? null;
  const current = (s) => active(s) ?? s.turns.at(-1);

  function seed(props = {}) {
    const s = { id: next('sess'), created_at: sessions.length + 1, environment: { type: 'none' }, metadata: {}, status: 'idle', actions: [], items: [], turns: [],
      inbox: [], opened: null, received: [], keys: new Set(), cancels: 0, cancelling: false, hidden: 0, ...props };
    sessions.push(s);
    return s;
  }

  function push(s, item) {
    s.items.push({ id: next(item.type === 'function_call' ? 'fc' : item.type === 'function_call_output' ? 'fco' : 'msg'), status: 'completed', ...item });
  }

  const userMessage = (text, turn) => ({ type: 'message', role: 'user', phase: null, content: [{ type: 'input_text', text }], turn_id: turn.id });

  // The agent picks up the oldest `count` inputs. A message starts a turn on
  // an idle session and steers an active one. A result ends the wait on its call.
  function work(s, count = Infinity) {
    for (const input of s.inbox.splice(0, count)) {
      let turn = active(s);
      if (input.kind === 'result') {
        push(s, { type: 'function_call_output', call_id: input.callId, output: input.text, error: null, turn_id: input.turnId });
        s.actions = s.actions.filter((action) => action.call_id !== input.callId);
      } else if (turn && state.unsteerable) {
        const refused = { id: next('turn'), status: 'failed', code: 'active_turn_not_steerable' };
        s.turns.push(refused);
        push(s, userMessage(input.text, refused));
      } else {
        if (!turn) s.turns.push(turn = { id: next('turn'), status: 'in_progress', code: null });
        push(s, userMessage(input.text, turn));
      }
    }
    const turn = active(s);
    if (!turn || s.actions.length) return;
    turn.status = 'in_progress';
    s.status = 'in_progress';
  }

  /** An accepted cancel takes effect. */
  function settle(s) {
    if (!s.cancelling) return;
    s.cancelling = false;
    const turn = active(s);
    if (turn) turn.status = 'cancelled';
    Object.assign(s, { status: s.status === 'failed' ? 'failed' : 'idle', actions: [] });
  }

  const invalid = (message) => json({ error: { type: 'invalid_request_error', code: 'invalid_request_error', message } }, 400);

  function events(s, body, key) {
    if (!Array.isArray(body.events) || body.events.length !== 1) return invalid('One event.');
    const [event] = body.events;
    if (event.type === 'agent.session.input.cancel') {
      s.cancels++;
      if (!active(s) && !state.slowCancel) return json({ error: { type: 'invalid_request_error', code: 'conflict_error', message: 'private-no-active-turn' } }, 409);
      s.cancelling = true;
      if (!state.slowCancel) settle(s);
      return new Response(null, { status: 202 });
    }
    if (s.status === 'failed') return json({ error: { type: 'invalid_request_error', code: 'conflict_error', message: 'private-failed' } }, 409);
    if (event.type === 'agent.session.input.message') {
      if (key !== null && s.keys.has(key)) return new Response(null, { status: 202 });
      const [{ role, content: [part, ...rest] }] = event.input;
      if (role !== 'user' || rest.length || part.type !== 'input_text' || typeof part.text !== 'string') return invalid('Bad message.');
      s.inbox.push({ kind: 'message', text: part.text });
      s.received.push(part.text);
      if (key !== null) s.keys.add(key);
    } else if (event.type === 'agent.session.input.tool_result') {
      // The SDK's tool dispatcher matches this message to tell a call that is not pending.
      if (!s.actions.some((a) => a.call_id === event.call_id && a.turn_id === event.turn_id)) return invalid(`Unknown pending tool call: ${event.call_id}`);
      if (event.success !== true || typeof event.output !== 'string') return invalid('Bad result.');
      s.inbox.push({ kind: 'result', callId: event.call_id, turnId: event.turn_id, text: event.output });
      s.received.push(event.output);
    } else return invalid('Unexpected event.');
    return new Response(null, { status: 202 });
  }

  function items(all, url) {
    const order = url.searchParams.get('order') ?? 'desc';
    const limit = Number(url.searchParams.get('limit') ?? 20);
    const after = url.searchParams.get('after');
    const ordered = order === 'asc' ? all : [...all].reverse();
    const from = after === null ? 0 : ordered.findIndex((item) => item.id === after) + 1;
    if (after !== null && from === 0) return invalid('Unknown cursor.');
    const data = ordered.slice(from, from + limit);
    return page(state.itemPatch && order === 'desc' ? [...state.itemPatch, ...data] : [...data, ...(state.itemPatch ?? [])], from + limit < ordered.length);
  }

  return {
    sessions,
    state,
    seed,
    work,
    settle,
    only() { assert.equal(sessions.length, 1, 'exactly one OpenAI session'); return sessions[0]; },
    say(s, text, phase = 'commentary') { push(s, { type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }], turn_id: current(s).id }); },
    finish(s) {
      current(s).status = 'completed';
      Object.assign(s, { status: 'idle', actions: [] });
    },
    /** Picks up what was sent, then waits on a call of `ask_user`, beside any call still pending. */
    ask(s, question) {
      work(s);
      const turn = current(s);
      const call = { type: 'function_call', turn_id: turn.id, call_id: next('call'), name: 'ask_user', arguments: { question } };
      push(s, { ...call, status: 'completed' });
      turn.status = 'waiting';
      Object.assign(s, { status: 'requires_action', actions: [...s.actions, call] });
      return call;
    },
    require(s, action) {
      work(s);
      current(s).status = 'waiting';
      Object.assign(s, { status: 'requires_action', actions: [{ turn_id: current(s).id, ...action }] });
    },
    failTurn(s, code) {
      Object.assign(current(s), { status: 'failed', code });
      s.status = 'idle';
    },
    failSession(s) { Object.assign(s, { status: 'failed', actions: [] }); },
    failNext(status, headers = {}, call = /./) { failures.push({ status, headers, call }); },
    async handle(url, init) {
      const method = (init.method ?? 'GET').toUpperCase();
      const headers = new Headers(init.headers);
      const text = init.body == null ? '' : String(init.body);
      const key = headers.get('Idempotency-Key');
      log.push({ origin: 'openai', method, path: url.pathname, query: url.search, key, beta: headers.get('OpenAI-Beta'), body: text });
      if (headers.get('Authorization') !== `Bearer ${OPENAI_API_KEY}`) return json({ error: { type: 'invalid_request_error', code: 'unauthorized', message: 'Bad key.' } }, 401);
      if (headers.get('OpenAI-Beta') !== 'agents=v1') return json({ error: { type: 'invalid_request_error', code: 'invalid_beta', message: 'Beta header.' } }, 400);
      if ([...url.searchParams.keys()].some((name) => !QUERY.has(name))) return json({ error: { type: 'invalid_request_error', message: 'Unknown query parameter.' } }, 400);
      if (failures.length && failures[0].call.test(`${method} ${url.pathname}`)) {
        const { status, headers: extra } = failures.shift();
        return json({ error: { type: 'server_error', message: 'private-openai-detail' } }, status, extra);
      }
      const prefix = '/v1/agents/sessions';
      if (!url.pathname.startsWith(prefix)) return json({ error: { message: 'Not found.' } }, 404);
      const rest = url.pathname.slice(prefix.length);
      if (rest === '' && method === 'POST') {
        const body = JSON.parse(text);
        const { agent_id, environment, input, metadata, ...other } = body;
        if (Object.keys(other).length || agent_id !== AGENT_ID || typeof input !== 'string' || !input || typeof metadata?.shortcut_session !== 'string') {
          return json({ error: { type: 'invalid_request_error', message: 'Bad session.' } }, 400);
        }
        const s = seed({ environment, metadata, opened: input, hidden: state.listLag, inbox: [{ kind: 'message', text: input }] });
        if (!state.loseCreate) return json(view(s));
        state.loseCreate = false;
        return json({ error: { type: 'server_error', message: 'Gateway timeout.' } }, 504);
      }
      if (rest === '' && method === 'GET') {
        const wanted = url.searchParams.get('metadata[shortcut_session]');
        const visible = sessions.filter((s) => {
          if (s.metadata.shortcut_session !== wanted && !state.ignoreFilter) return false;
          if (s.hidden === 0) return true;
          s.hidden--;
          return false;
        });
        const ordered = url.searchParams.get('order') === 'asc' ? visible : [...visible].reverse();
        const after = url.searchParams.get('after');
        const from = after === null ? 0 : ordered.findIndex((s) => s.id === after) + 1;
        const limit = Number(url.searchParams.get('limit') ?? 20);
        return page(ordered.slice(from, from + limit).map(view), from + limit < ordered.length);
      }
      const [, id, sub, turnId, turnItems] = rest.match(/^\/([^/]+)(?:\/(events|items|turns)(?:\/([^/]+)(\/items)?)?)?$/) ?? [];
      const s = sessions.find((candidate) => candidate.id === decodeURIComponent(id ?? '') && !candidate.deleted);
      if (!s) return json({ error: { type: 'invalid_request_error', code: 'not_found_error', message: 'No such session.' } }, 404);
      if (!sub && method === 'GET') return json(view(s));
      if (sub === 'items' && method === 'GET') return items(s.items, url);
      if (sub === 'turns' && turnId && method === 'GET') {
        const turn = s.turns.find((candidate) => candidate.id === turnId);
        if (!turn) return json({ error: { message: 'No such turn.' } }, 404);
        return turnItems ? items(s.items.filter((item) => item.turn_id === turnId), url) : json(turnView(s, turn));
      }
      if (sub === 'events' && method === 'POST') {
        const answer = events(s, JSON.parse(text), key);
        if (!state.loseSend || answer.status !== 202) return answer;
        state.loseSend = false;
        return json({ error: { type: 'server_error', message: 'Gateway timeout.' } }, 504);
      }
      return json({ error: { message: 'Unexpected.' } }, 405);
    },
  };
}

const bridge = await bridgeHarness({
  root: new URL('..', import.meta.url),
  secrets: { OPENAI_API_KEY, OPENAI_AGENT_ID: AGENT_ID },
  sensitive: SENSITIVE,
  vendor: { origin: OPENAI, env: { OPENAI_API_BASE: `${OPENAI}/v1` }, mock: mockAgents },
});
export const { mod, SECRETS } = bridge;

export function setup(t) {
  const h = bridge.setup(t);
  return Object.assign(h, {
    openai: h.vendor,
    /** Runs `action` once, just before the vendor handles the first request whose method and path match. */
    before(pattern, action) {
      const { handle } = h.vendor;
      h.vendor.handle = (url, init) => {
        if (!pattern.test(`${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`)) return handle(url, init);
        h.vendor.handle = handle;
        action();
        return handle(url, init);
      };
    },
    openaiCalls: (method, pattern = /./) => h.requests.filter((r) => r.origin === 'openai' && r.method === method && pattern.test(r.path)),
    submitted: () => h.requests.filter((r) => r.origin === 'openai' && r.method === 'POST' && r.path.endsWith('/events')).map((r) => JSON.parse(r.body).events[0].type),
  });
}
