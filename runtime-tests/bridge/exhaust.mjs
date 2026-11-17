// Runs scripts of events, alarms, and backend faults through a bridge's real
// webhook and alarm loop against fake-backend.ts, and holds each step to the
// rules in ledger.mjs. `explore` runs every script a scope allows, shortest
// first. `replay` runs one. ../README.md describes both.
//
// A script is a list of steps:
//   'created'          Shortcut delivers session.created (turn 1)
//   'reply 3'          Shortcut delivers the reply of turn 3
//   'stop 2'           Shortcut delivers the stop of turn 2
//   'again'            Shortcut delivers the last event a second time
//   'ahead 2'          the user sends the reply of turn 2: Shortcut moves to
//                      that turn and has not delivered the reply yet, so it
//                      answers a write for an older turn with a 409
//   'close'            the session is closed in Shortcut
//   'finish'           the agent finishes its turn in the newest conversation
//   'gone'             the newest conversation ends on its own
//   'tick'             the alarm fires and the step runs
//   'tick: send fails' the step's first send fails before it reaches the backend
//   'tick: send lost'  it reaches the backend and its answer is lost
//   'tick: send dies'  it is answered and the step dies before its save
//   'tick: send refused' the backend refuses it with a 401
//   'tick: send 2 ...' the same for the step's second send, and so on for
//                      open, prepare, observe, and halt
//   'tick: stop 2 during prepare'
//                      Shortcut delivers the stop of turn 2 while the step's
//                      first prepare is out, and has the bridge's answer
//                      before the backend's reaches the step. Any event, and
//                      any call, as for a fault
//   'rest'             Shortcut delivers the reply it is ahead by, every agent
//                      finishes, and the alarms run until none is set
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import { CONTEXT, REQUEST, bridgeHarness } from './harness.mjs';
import { ledger } from './ledger.mjs';

const SID = 'exhaust';
const EPOCH = Date.UTC(2026, 9, 1, 12);
const CALLS = ['open', 'prepare', 'send', 'observe', 'halt'];
const MODES = ['fails', 'lost', 'dies', 'refused'];
const READS = ['prepare', 'observe'];
const REST_ALARMS = 40;
// The longest script of the default scope has 9 steps. A script this long belongs to a bridge whose alarms never run out, and the search over it would not end.
const LONGEST = 40;
// One alarm makes a handful of backend calls. A step that makes this many would go on making them.
const MOST_CALLS = 30;
const replyText = (turn) => `reply-${turn}`;

export const BACKENDS = [false, true].flatMap((keeps) => [false, true].flatMap((empty) => [false, true].map((dedupes) => ({ keeps, empty, dedupes }))));

export const describeBackend = ({ keeps, empty, dedupes }) =>
  `a backend that ${keeps ? 'keeps' : 'ends'} its conversation on a stop, opens it ${empty ? 'empty' : 'with the request'}, and ${dedupes ? 'deduplicates' : 'repeats'} a repeated send`;

export const loadBridge = async (root) => {
  const bridge = await bridgeHarness({
    root,
    secrets: {},
    sensitive: /private|token-\d|refresh-\d/,
    backend: new URL('./fake-backend.ts', import.meta.url),
    vendor: { env: {}, mock: (log) => bridge.mod.backend.script(log) },
  });
  return bridge;
};

const parse = (step) => {
  const during = step.match(/^tick: (created|(?:reply|stop) \d+) during (\w+)(?: (\d+))?$/);
  if (during) {
    assert.ok(CALLS.includes(during[2]), `no step ${JSON.stringify(step)}`);
    return { kind: 'tick', at: { call: during[2], nth: Number(during[3] ?? 1), arrives: during[1] } };
  }
  const fault = step.match(/^tick: (\w+)(?: (\d+))? (\w+)$/);
  if (fault) {
    assert.ok(CALLS.includes(fault[1]) && MODES.includes(fault[3]), `no step ${JSON.stringify(step)}`);
    return { kind: 'tick', at: { call: fault[1], nth: Number(fault[2] ?? 1), mode: fault[3] } };
  }
  const event = step.match(/^(reply|stop|ahead) (\d+)$/);
  if (event) return { kind: event[1], turn: Number(event[2]) };
  assert.ok(['created', 'again', 'close', 'finish', 'gone', 'tick', 'rest'].includes(step), `no step ${JSON.stringify(step)}`);
  return { kind: step, turn: 1 };
};

/** One Shortcut session on one bridge with one fake backend, which a script drives and a snapshot rewinds. `turns` are the replies Shortcut holds. */
export async function world(t, bridge, facts, turns = [2, 3, 4]) {
  const h = bridge.setup(t);
  const fake = h.vendor;
  h.env.FAKE = fake;
  Object.assign(fake.facts, { ...facts, linked: !facts.empty });
  await h.connect();
  t.mock.timers.setTime(EPOCH);
  const led = ledger({ request: REQUEST, context: CONTEXT, reply: replyText }, { opensEmpty: facts.empty });
  const transient = () => new bridge.mod.BackendError({ kind: 'transient' });
  const refusal = (status = 401) => new bridge.mod.BackendError({ kind: 'rejected', status });

  // Shortcut holds every event from the start. Each is delivered when the script says.
  const events = { created: h.shortcut.open(SID), 'stop 1': h.shortcut.stop(SID) };
  for (const turn of turns) {
    events[`reply ${turn}`] = h.shortcut.prompt(SID, replyText(turn));
    events[`stop ${turn}`] = h.shortcut.stop(SID);
  }
  Object.assign(h.shortcut.sessions.get(SID), { turn: 1, status: 'pending', stopRequested: false, outcome: null });
  h.env.SESSIONS.get(SID);
  const storage = h.env.SESSIONS.storages.get(SID);
  const session = () => h.shortcut.sessions.get(SID);

  let aliases = new Map();
  let delivered = [];
  let armed = null;
  let step = { calls: [], counts: {} };
  const alias = (key) => aliases.get(key) ?? aliases.set(key, `send-${aliases.size + 1}`).get(key);

  const { handle } = h.shortcut;
  h.shortcut.handle = async (url, init) => {
    const response = await handle(url, init);
    if (response.status === 201 && url.pathname.endsWith('/activities')) {
      const { turn, content } = JSON.parse(String(init.body));
      led.posted({ type: content.type, turn });
    }
    return response;
  };

  // The step's next save fails and the object restarts, as when it is evicted after a call and before the save.
  // One job can make two calls before it saves, so the bridge learns nothing from a call it makes while `dying` either.
  const { put } = storage;
  let dying = false;
  function dieAtSave() {
    dying = true;
    storage.put = async () => {
      storage.put = put;
      h.env.SESSIONS.restart();
      throw new Error('evicted');
    };
  }
  /** The call answered, and the step saves what it learned from it. */
  const learns = (mode) => mode === null && !dying;

  const raw = { ...fake.backend };
  const faulted = (call, run) => async (...args) => {
    const nth = (step.counts[call] = (step.counts[call] ?? 0) + 1);
    step.calls.push({ call, nth });
    if (step.calls.length > MOST_CALLS) throw Object.assign(new Error('the step never ends'), { name: 'EndlessStep' });
    led.calling();
    const hit = armed?.call === call && armed.nth === nth ? armed : null;
    if (hit) armed = null;
    const mode = hit?.mode ?? null;
    try {
      const answer = await run(mode, ...args);
      if (mode === 'lost') throw transient();
      if (mode === 'dies') dieAtSave();
      return answer;
    } finally {
      // The event arrives while the call is out, whatever the call comes to. The bridge can read it only once the call has answered.
      if (hit?.arrives) await deliver(hit.arrives, parse(hit.arrives));
    }
  };
  Object.assign(fake.backend, {
    open: faulted('open', async (mode, request) => {
      led.opening(request.key, request.text);
      if (mode === 'fails') throw transient();
      if (mode === 'refused') {
        led.refused(request.key);
        throw refusal();
      }
      const before = fake.chats.length;
      const opened = await raw.open(request);
      const made = fake.chats[before];
      led.opened(request.key, { conversation: opened.conversation.id, landed: Boolean(made) && made.opened !== null, learned: learns(mode) });
      return opened;
    }),
    prepare: faulted('prepare', async (mode, conversation) => {
      if (mode === 'fails') throw transient();
      if (mode === 'refused') {
        led.refused(null, conversation.id);
        throw refusal();
      }
      const ready = await raw.prepare(conversation);
      // Told only what the bridge was: a prepare whose answer is lost teaches nothing.
      if (learns(mode)) led.prepared(conversation.id, { ready: ready.kind === 'ready', empty: ready.empty ?? false });
      return ready;
    }),
    send: faulted('send', async (mode, conversation, message) => {
      const key = alias(message.key);
      led.sending(conversation.id, key, message.text);
      if (mode === 'fails') throw transient();
      const chat = fake.chats.find((candidate) => candidate.id === conversation.id);
      // The fake scripts `gone` for prepare alone. A conversation that ended on its own takes no message either.
      const ended = chat.gone && !chat.halted;
      if (mode === 'refused' || ended) {
        led.refused(key);
        throw refusal(ended ? 410 : 401);
      }
      const before = chat.received.length;
      const memo = await raw.send(conversation, message);
      led.sent(key, { landed: chat.received.length > before, learned: learns(mode) });
      return memo;
    }),
    observe: faulted('observe', async (mode, conversation) => {
      if (mode === 'fails') throw transient();
      if (mode === 'refused') {
        led.ended();
        throw refusal();
      }
      const seen = await raw.observe(conversation);
      if (learns(mode) && ['finished', 'failed'].includes(seen.status.kind)) led.ended();
      return seen;
    }),
    halt: faulted('halt', async (mode, target) => {
      if (mode === 'fails') throw transient();
      if (mode === 'refused') throw refusal();
      return raw.halt(target);
    }),
  });

  const newest = () => fake.chats.at(-1);
  const holdsMessage = (chat) => chat.opened !== null || chat.received.length > 0;
  const canFinish = () => Boolean(newest()) && newest().status.kind === 'working' && !newest().gone && !newest().halted;
  const canEnd = () => Boolean(newest()) && holdsMessage(newest()) && !newest().gone && !newest().halted;

  async function deliver(label, { kind, turn }) {
    const s = session();
    // Shortcut's own turn follows what it has delivered, so the bridge never writes to a turn Shortcut has moved past unseen.
    if (kind === 'stop' ? turn >= s.turn : turn > s.turn) Object.assign(s, { turn, stopRequested: kind === 'stop', ...(turn > s.turn ? { outcome: null, status: 'active' } : {}) });
    assert.equal((await h.deliver(events[label])).status, 200);
    delivered.push(label);
    led.arrived({ type: kind, turn });
  }

  async function tick(at = null) {
    armed = at;
    dying = false;
    step = { calls: [], counts: {} };
    const logged = h.logs.length;
    await h.tick(SID);
    assert.equal(armed, null, `the step made no ${at?.call} ${at?.nth}. A call that failed is tried again only after its wait, in a step of its own.`);
    storage.put = put;
    for (const [level, message, detail] of h.logs.slice(logged)) {
      if (level !== 'error' || !/step failed/.test(String(message))) continue;
      if (detail?.error === 'StalledError') led.saw('loop', 'a step stalled');
      else if (detail?.error === 'EndlessStep') led.saw('loop', `one step made more than ${MOST_CALLS} backend calls`);
      else if (at?.mode !== 'dies') led.saw('loop', `a step threw ${detail?.error}`);
    }
    for (const line of fake.misuse.splice(0)) led.saw('keys', `the backend saw that ${line}`);
    return step.calls;
  }

  async function rest() {
    // A reply that Shortcut is ahead by is on its way, and the bridge may be waiting for it.
    const ahead = `reply ${session().turn}`;
    if (events[ahead] && !delivered.includes(ahead)) await deliver(ahead, parse(ahead));
    const finish = () => fake.chats.filter((chat) => !chat.gone).forEach((chat) => {
      if (chat.status.kind === 'working') led.finished(chat.id);
      chat.status = { kind: 'finished' };
    });
    for (let i = 0; i < REST_ALARMS && (await storage.getAlarm()) !== null; i++) {
      finish();
      await tick();
    }
    finish();
    if ((await storage.getAlarm()) !== null) return led.saw('loop', `the alarms did not run out in ${REST_ALARMS} steps after every agent finished`);
    const s = session();
    const links = fake.facts.linked ? 0 : s.external_urls.length + h.shortcut.activities(SID).filter((a) => /\]\(/.test(a.content.body)).length;
    led.rested({ working: fake.chats.filter((chat) => holdsMessage(chat) && !chat.halted && !chat.gone).length, links });
  }

  const w = {
    chats: fake.chats,

    /** Runs one step and returns the backend calls it made. */
    async act(label) {
      const parsed = parse(label);
      switch (parsed.kind) {
        case 'created': case 'reply': case 'stop':
          return void (await deliver(label, parsed));
        case 'again':
          return void assert.equal((await h.deliver(events[delivered.findLast((event) => event !== 'close')])).status, 200);
        case 'ahead':
          return void Object.assign(session(), { turn: parsed.turn, stopRequested: false, outcome: null, status: 'active' });
        case 'close':
          delivered.push('close');
          session().closed = true;
          return void led.arrived({ type: 'close' });
        case 'finish':
          newest().status = { kind: 'finished' };
          return void led.finished(newest().id);
        case 'gone':
          return void Object.assign(newest(), { gone: true, status: { kind: 'failed', body: 'The Fake session ended.', keep: false } });
        case 'tick':
          return tick(parsed.at ?? null);
        case 'rest':
          return void (await rest());
      }
    },

    /** The rules the steps since the last call broke, as `rule: what happened`. */
    broken: () => led.broken(),

    /** The steps that could change something now, backend faults aside, each with what it spends of a scope. Shortcut ahead of the bridge is a fault of Shortcut's, and a scope that allows it counts it as one. */
    async enabled({ from, ahead }) {
      const waiting = from.filter((label) => !delivered.includes(label));
      return [
        ...waiting.map((label) => [label, 'events']),
        ...(ahead ? waiting.map(parse).filter(({ kind, turn }) => kind === 'reply' && turn > session().turn).map(({ turn }) => [`ahead ${turn}`, 'faults']) : []),
        ...(canFinish() ? [['finish', 'finish']] : []),
        ...(canEnd() ? [['gone', 'gone']] : []),
        ...((await storage.getAlarm()) !== null ? [['tick', null]] : []),
      ];
    },
    /** Nothing is scheduled and an event has arrived, so delivering it again should change nothing. */
    idle: async () => (await storage.getAlarm()) === null && delivered.some((event) => event !== 'close'),

    async snapshot() {
      return serialize({ data: [...storage.data], alarm: await storage.getAlarm(), chats: fake.chats, session: session(), now: Date.now(), ledger: led.state, aliases: [...aliases], delivered });
    },
    async restore(snapshot) {
      const copy = deserialize(snapshot);
      storage.data.clear();
      for (const [key, value] of copy.data) storage.data.set(key, value);
      if (copy.alarm === null) await storage.deleteAlarm();
      else await storage.setAlarm(copy.alarm);
      fake.chats.splice(0, fake.chats.length, ...copy.chats);
      h.shortcut.sessions.set(SID, copy.session);
      t.mock.timers.setTime(copy.now);
      led.state = copy.ledger;
      aliases = new Map(copy.aliases);
      ({ delivered } = copy);
      h.env.SESSIONS.restart();
      h.requests.length = 0;
      h.logs.length = 0;
      // The harness's mocks record every call they take.
      for (const mocked of [globalThis.fetch, console.log, console.warn, console.error]) mocked.mock.resetCalls();
    },

    /**
     * A hash of what the search compares two scripts by: the stored state,
     * the inbox, whether an alarm is set and due, the backend's chats,
     * Shortcut's session, the ledger, and which events were delivered. The
     * search takes two scripts with the same name to have the same future.
     * Send keys are named by the order they were first used. Of the clock
     * only what decides which jobs the next alarms run is kept: how long
     * each wait still has, or that it ends after the next poll. How far off
     * that poll is, and how often the agent was quiet, is left out, so an
     * agent that stays quiet is polled once and not six times.
     */
    async name() {
      const state = storage.data.get('state');
      const now = Date.now();
      const poll = state?.phase.at > now ? state.phase.at : null;
      const wait = (deadline) => (deadline === null || deadline <= now ? 0 : poll !== null && deadline > poll ? 'after the poll' : deadline - now);
      const timeless = state && { ...state, notBefore: Object.values(state.notBefore).map(wait), phase: { ...state.phase, at: poll !== null, delayMs: 0, check: false, sentAt: 0, heartbeatAt: 0 } };
      const inbox = [...storage.data].filter(([key]) => key.startsWith('inbox:')).map(([, event]) => event.id);
      const s = session();
      const alarm = await storage.getAlarm();
      let json = JSON.stringify([
        timeless, inbox, alarm === null ? null : alarm > now,
        fake.chats.map((chat) => [chat.key, chat.opened, chat.received, chat.sends, chat.status.kind, chat.gone, chat.halted]),
        [s.turn, s.stopRequested, s.outcome, s.closed, s.activities.map((a) => `${a.key} ${a.content.body}`).sort(), s.external_urls],
        led.state, [...delivered].sort(),
      ]);
      for (const [key, name] of aliases) json = json.replaceAll(`${key}"`, `${name}"`);
      return createHash('sha1').update(json).digest('base64');
    },
  };
  return w;
}

/** Runs one script from the start and returns each rule it broke, as `rule: what happened`. */
export async function replay(w, steps) {
  const found = [];
  for (const label of steps) {
    await w.act(label);
    found.push(...w.broken());
  }
  return found;
}

/** What the agent was told in each conversation, oldest first: the open's text, then each message. */
export const told = (w) => w.chats.map((chat) => [chat.id, ...(chat.opened === null ? [] : [chat.opened]), ...chat.received]);

const ruleOf = (problem) => problem.slice(0, problem.indexOf(':'));
const BUDGETS = ['events', 'faults', 'finish', 'gone', 'total'];
const within = (left, most) => BUDGETS.every((budget) => left[budget] <= most[budget]);
const spend = (left, budget) => (budget ? { ...left, [budget]: left[budget] - 1, total: left.total - 1 } : left);
const affords = (left, budget) => !budget || (left[budget] > 0 && left.total > 0);
const budgetsOf = (scope) => Object.fromEntries(BUDGETS.map((budget) => [budget, scope[budget] ?? Infinity]));

/** The faults a scope allows on the calls one alarm made. A read changes nothing at the backend, so one whose answer is lost is one that failed. */
const faultsOn = (calls, scope) => calls.flatMap(({ call, nth }) => MODES
  .filter((mode) => !(mode === 'lost' && READS.includes(call)) && !(mode === 'refused' && scope.refuse && !scope.refuse.includes(call)) && (!scope.only || scope.only.includes(`${call} ${mode}`)))
  .map((mode) => `tick: ${call}${nth > 1 ? ` ${nth}` : ''} ${mode}`));

/**
 * The other ways one alarm can run, given the calls it made with nothing in
 * its way, each with what it spends of a scope: a fault on one of the calls,
 * or one of `events`, which Shortcut has not delivered yet, arriving during
 * one. `scope.during` names the events that may arrive that way.
 */
const waysOf = (calls, scope, left, events) => [
  ...(affords(left, 'faults') ? faultsOn(calls, scope).map((label) => [label, 'faults']) : []),
  ...(affords(left, 'events') ? calls.flatMap(({ call, nth }) => events.filter((event) => scope.during?.includes(event)).map((event) => [`tick: ${event} during ${call}${nth > 1 ? ` ${nth}` : ''}`, 'events'])) : []),
];

/**
 * Runs every script the scope allows, shortest first, and stops a script at
 * the first rule it breaks. `scope` is `{ events, faults, finish, gone }`, how
 * many of each a script may hold, `total`, how many of them together, `from`,
 * the events it may deliver, `during`, those of them that may also arrive
 * while a backend call is out, `ahead`, whether Shortcut may be a reply
 * ahead, which then counts as a fault, `refuse`, the calls the backend may
 * refuse when not all, and `only`, the backend faults it may hold when not
 * all. A
 * script that reaches a state an earlier one reached with as much of the
 * scope left ends there, since the earlier one's futures hold all of its own.
 * Returns the shortest script that breaks each rule, and how much was run:
 * `states` distinct states, `steps` steps run, and `scripts`, the number of
 * different scripts within the scope that those states stand for.
 */
export async function explore(w, scope) {
  const start = budgetsOf(scope);
  const nodes = [{ parent: null, via: null, left: start, steps: 0, snapshot: await w.snapshot(), edges: [] }];
  const seen = new Map([[await w.name(), [0]]]);
  const broken = new Map();
  let steps = 0;
  const script = (id, ...last) => {
    const path = last;
    for (let at = id; nodes[at].parent !== null; at = nodes[at].parent) path.unshift(nodes[at].via);
    return path;
  };
  const record = (id, last, problems) => {
    for (const problem of problems) if (!broken.has(ruleOf(problem))) broken.set(ruleOf(problem), { problem, steps: script(id, ...last) });
  };

  for (let frontier = [0]; frontier.length;) {
    const next = [];
    for (const id of frontier) {
      const node = nodes[id];
      const from = node.snapshot;
      node.snapshot = null;
      // Runs one step from this state. Returns the calls it made, or null when it broke a rule.
      const run = async (label, budget) => {
        await w.restore(from);
        const calls = (await w.act(label)) ?? [];
        steps++;
        const problems = w.broken();
        if (problems.length) {
          node.edges.push({ to: null, budget });
          record(id, [label], problems);
          return null;
        }
        const name = await w.name();
        // A step that changes nothing makes no new script.
        if (name === own) return calls;
        const left = spend(node.left, budget);
        const known = seen.get(name) ?? seen.set(name, []).get(name);
        const covering = known.find((other) => within(left, nodes[other].left));
        if (covering !== undefined) {
          node.edges.push({ to: covering, budget });
          return calls;
        }
        const child = nodes.push({ parent: id, via: label, left, steps: node.steps + 1, snapshot: await w.snapshot(), edges: [] }) - 1;
        known.push(child);
        node.edges.push({ to: child, budget });
        if (nodes[child].steps < LONGEST) next.push(child);
        else record(child, [], [`loop: a script of ${LONGEST} steps still changes what the bridge holds`]);
        if (await w.idle()) {
          await w.act('again');
          await w.act('tick');
          steps += 2;
          const problems = w.broken();
          record(child, ['again', 'tick'], (await w.name()) === name || problems.length ? problems : ['redelivered: an event delivered a second time changed what the bridge holds']);
          await w.restore(nodes[child].snapshot);
        }
        if (label.startsWith('tick')) {
          await w.act('rest');
          steps++;
          record(child, ['rest'], w.broken());
        }
        return calls;
      };

      await w.restore(from);
      const own = await w.name();
      const enabled = await w.enabled(scope);
      const events = enabled.filter(([, budget]) => budget === 'events').map(([label]) => label);
      for (const [label, budget] of enabled) {
        if (!affords(node.left, budget)) continue;
        const calls = await run(label, budget);
        if (label !== 'tick') continue;
        for (const [way, spent] of waysOf(calls ?? [], scope, node.left, events)) await run(way, spent);
      }
    }
    frontier = next;
  }

  // Every state is where some script ends, so the scripts are the paths from the start that the scope can pay for.
  const counted = new Map();
  const count = (id, left) => {
    const key = `${id}:${BUDGETS.map((budget) => left[budget])}`;
    if (counted.has(key)) return counted.get(key);
    counted.set(key, 0n);
    let total = 1n;
    for (const { to, budget } of nodes[id].edges) {
      if (!affords(left, budget)) continue;
      total += to === null ? 1n : count(to, spend(left, budget));
    }
    counted.set(key, total);
    return total;
  };
  return { states: nodes.length, steps, scripts: count(0, start), broken: [...broken].map(([rule, found]) => ({ rule, ...found })) };
}

/**
 * Counts the scripts of a scope by running each from its own start, with no
 * state merged. Slow, and what `explore` is tested against: a search that
 * merged two states with different futures would count other scripts.
 */
export async function runEach(w, scope) {
  let scripts = 0;
  const from = async (snapshot, name, left, steps) => {
    scripts++;
    assert.ok(steps < LONGEST, `a script of ${LONGEST} steps still changes what the bridge holds`);
    const run = async (label, budget) => {
      await w.restore(snapshot);
      const calls = (await w.act(label)) ?? [];
      if (w.broken().length) return void scripts++;
      const reached = await w.name();
      if (reached !== name) await from(await w.snapshot(), reached, spend(left, budget), steps + 1);
      return calls;
    };
    await w.restore(snapshot);
    const enabled = await w.enabled(scope);
    const events = enabled.filter(([, budget]) => budget === 'events').map(([label]) => label);
    for (const [label, budget] of enabled) {
      if (!affords(left, budget)) continue;
      const calls = await run(label, budget);
      if (label !== 'tick') continue;
      for (const [way, spent] of waysOf(calls ?? [], scope, left, events)) await run(way, spent);
    }
  };
  await from(await w.snapshot(), await w.name(), budgetsOf(scope), 0);
  return BigInt(scripts);
}
