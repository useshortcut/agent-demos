// Seeded walks through the real webhook and alarm loop against
// fake-backend.ts: events in any order and more than once, failures that did
// and did not land on each of the five calls, crashes at a save, and every
// mix of kept, empty, and linked backends. Each run is checked against what
// the core owes whatever the order. ../README.md lists the invariants.
//   FUZZ_RUNS=20000 node --test ../runtime-tests/bridge/fuzz.test.mjs
//   FUZZ_SEED=137 FUZZ_RUNS=1 FUZZ_SHOW=137 prints that seed's trail when it fails.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { CONTEXT, REQUEST, bridgeHarness } from './harness.mjs';

const root = pathToFileURL(`${process.cwd()}/`);
assert.ok(existsSync(new URL('src/core/port.ts', root)), 'fuzz.test.mjs tests the bridge in the current directory. Run `npm test` inside a bridge.');

const bridge = await bridgeHarness({
  root,
  secrets: {},
  sensitive: /private|token-\d|refresh-\d/,
  backend: new URL('./fake-backend.ts', import.meta.url),
  vendor: { env: {}, mock: (log) => bridge.mod.backend.script(log) },
});
const { BackendError } = bridge.mod;

const RUNS = Number(process.env.FUZZ_RUNS ?? 1000);
const FROM = Number(process.env.FUZZ_SEED ?? 1);
const STEPS = 40;
const EPOCH = Date.UTC(2026, 9, 1, 12);
const CONTEXT_BLOCK = `Context from Shortcut:\n\n${CONTEXT}`;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const copies = (text, part) => text.split(part).length - 1;
const turnsIn = (text) => [...text.matchAll(/reply-(\d+)\b/g)].map(([, turn]) => Number(turn));

// Every run is its own Shortcut session with its own fake backend, on one
// connected bridge, so a run costs no OAuth exchange and depends on no other.
async function run(t, h, seed) {
  const rand = rng(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const sid = `fuzz-${seed}`;
  const firstKey = `shortcut-session-${sid}-1`;
  const fake = bridge.mod.backend.script(h.requests);
  h.env.FAKE = fake;
  t.mock.timers.setTime(EPOCH);
  const logged = h.logs.length;
  Object.assign(fake.facts, { keeps: rand() < 0.6, empty: rand() < 0.6, linked: rand() < 0.5 });
  const trail = [`facts ${JSON.stringify(fake.facts)}`];
  const problems = [];

  // The run's clock is the number of alarms started. A step applies its whole
  // inbox before it runs a job, so a backend call in alarm n knows every event
  // delivered before alarm n began.
  let alarms = 0;
  const knownBy = (event, alarm) => event !== null && event.at < alarm;
  let created = null;
  const stops = [];
  /** The first alarm in which Shortcut refused a write or the bridge ended a turn with an error. Either drops what the turn still held. */
  let turnDropped = Infinity;

  // Everything the agent was told, in order. `fixed` is the alarm in which its text was fixed: an open's first attempt, or a send's prepare.
  const told = [];
  const firstAttempt = new Map();
  const seen = new Map();
  const fixedAt = new Map();
  let prepared = null;
  let last = null;
  let lastSend = null;
  let answersLost = false;
  let calls = 0;
  const { open, prepare, send } = fake.backend;
  fake.backend.open = async (request) => {
    calls++;
    if (!firstAttempt.has(request.key)) firstAttempt.set(request.key, alarms);
    const before = fake.chats.length;
    try {
      return await open(request);
    } finally {
      const chat = fake.chats[before];
      lastSend = null;
      if (chat && chat.opened !== null) told.push({ chat, text: chat.opened, fixed: firstAttempt.get(request.key), called: alarms, introduces: true, lost: false });
    }
  };
  fake.backend.prepare = async (conversation) => {
    calls++;
    lastSend = null;
    const result = await prepare(conversation);
    if (result.kind === 'ready') prepared = alarms;
    return result;
  };
  fake.backend.send = async (conversation, message) => {
    calls++;
    trail.push(`  send ${conversation.id} ${message.key} ${JSON.stringify(message.text.slice(0, 60))}`);
    if (prepared !== null) {
      if (seen.has(message.key)) problems.push(`a newly prepared send reuses key ${message.key}`);
      fixedAt.set(message.key, prepared);
    } else if (!last || last.key !== message.key || last.text !== message.text || last.id !== conversation.id) {
      problems.push(`a retried send changed: ${JSON.stringify(last)} -> ${JSON.stringify({ ...message, id: conversation.id })}`);
    }
    if (seen.has(message.key) && seen.get(message.key) !== message.text) problems.push(`key ${message.key} carries two texts`);
    seen.set(message.key, message.text);
    prepared = null;
    last = { ...message, id: conversation.id };
    const chat = fake.chats.find((candidate) => candidate.id === conversation.id);
    const before = chat.received.length;
    const introduces = chat.opened === null && before === 0;
    let answered = false;
    try {
      const memo = await send(conversation, message);
      answered = true;
      return memo;
    } finally {
      lastSend = null;
      if (chat.received.length > before) {
        lastSend = { chat, text: message.text, fixed: fixedAt.get(message.key), called: alarms, introduces, lost: !answered };
        told.push(lastSend);
      }
    }
  };

  for (const call of ['observe', 'halt']) {
    const original = fake.backend[call];
    fake.backend[call] = async (...args) => {
      calls++;
      lastSend = null;
      return original(...args);
    };
  }

  const { handle } = h.shortcut;
  h.shortcut.handle = async (url, init) => {
    const response = await handle(url, init);
    const posted = init.body && url.pathname.endsWith('/activities') ? JSON.parse(String(init.body)) : null;
    if (response.status >= 400 || posted?.content?.type === 'error') turnDropped = Math.min(turnDropped, alarms);
    return response;
  };

  const pool = [];
  const delivered = [];
  const session = () => h.shortcut.sessions.get(sid);
  const storage = () => h.env.SESSIONS.storages.get(sid);
  // A crash can take the webhook's own write. Shortcut then delivers the event again, so it goes back into the pool.
  const deliver = async (event) => {
    const { status } = await h.deliver(event);
    trail.push(`deliver ${event.type} turn ${event.activity?.turn} ${event.activity?.signal ?? ''} -> ${status}`);
    if (status !== 200) return pool.push(event);
    if (!delivered.includes(event)) delivered.push(event);
    if (event.type === 'session.created') created ??= { at: alarms };
    // The mock marks the session stopped when it builds the event. Here the bridge learns of the stop first.
    if (event.activity?.signal === 'stop') {
      session().stopRequested = true;
      stops.push({ at: alarms, turn: event.activity.turn });
    }
  };
  const reply = () => h.shortcut.prompt(sid, `reply-${session().turn + 1}`);
  const stop = () => {
    const requested = session().stopRequested;
    const event = h.shortcut.stop(sid);
    session().stopRequested = requested;
    return event;
  };
  const tick = async () => {
    alarms++;
    await h.tick(sid);
    const state = storage()?.data.get('state');
    const waiting = (state?.phase.prompt ?? []).concat(state?.phase.extra ?? [], state?.phase.then ?? [], state?.phase.send?.prompt ?? []).map((reply) => reply.turn);
    trail.push(`alarm ${alarms}: ${state ? `${state.phase.kind}${state.phase.send ? ' prepared' : ''}${state.phase.attempted ? ' attempted' : ''} [${waiting}] generation ${state.generation} turn ${state.turn} cutoff ${state.cutoff} sent ${state.sent}${state.late ? ' late' : ''}` : 'no state'}`);
  };

  pool.push(h.shortcut.open(sid));
  if (rand() < 0.6) pool.push(reply());

  for (let step = 0; step < STEPS; step++) {
    const roll = rand();
    if (roll < 0.22 && pool.length) {
      // A session.created is held back half the time, so it often arrives after a reply.
      const late = pool.length > 1 && pool[0].type === 'session.created' && rand() < 0.5 ? 1 : 0;
      const [event] = pool.splice(late + Math.floor(rand() * (pool.length - late)), 1);
      await deliver(event);
    } else if (roll < 0.32) {
      pool.push(reply());
    } else if (roll < 0.40) {
      pool.push(stop());
    } else if (roll < 0.45 && delivered.length) {
      await deliver(pick(delivered));
    } else if (roll < 0.58) {
      const call = pick(['open', 'open', 'prepare', 'prepare', 'send', 'send', 'observe', 'halt']);
      const landed = rand() < 0.5;
      const failure = rand() < 0.2 ? { kind: 'hold', retryAfterMs: 2_000 } : { kind: 'transient' };
      if (landed) answersLost = true;
      trail.push(`failNext ${call} ${failure.kind} landed=${landed}`);
      fake.failNext(call, new BackendError(failure), { landed });
    } else if (roll < 0.64 && storage()) {
      const store = storage();
      const put = store.put;
      const before = calls;
      answersLost = true;
      trail.push('crash at the save after the next backend call');
      store.put = async (...args) => {
        if (calls === before) return put.apply(store, args);
        store.put = put;
        h.env.SESSIONS.restart();
        if (lastSend) lastSend.lost = true;
        throw new Error('evicted');
      };
    } else if (roll < 0.74 && fake.chats.length) {
      const chat = fake.chats.at(-1);
      const status = pick([{ kind: 'finished' }, { kind: 'working' }, { kind: 'asked', on: 'user' }, { kind: 'asked', on: 'approval' }, { kind: 'failed', body: 'Failed.', keep: rand() < 0.5 }]);
      if (rand() < 0.5) fake.say(chat, `said at ${step}`);
      if (rand() < 0.08) chat.gone = true;
      chat.status = status;
      trail.push(`chat ${chat.id} ${JSON.stringify(status)} gone=${chat.gone}`);
    } else if (storage()) {
      await tick();
    }
  }
  while (pool.length) await deliver(pool.shift());
  let rested = false;
  for (let i = 0; i < 400; i++) {
    for (const chat of fake.chats) if (chat.status.kind !== 'finished') chat.status = { kind: 'finished' };
    if (!storage() || (await h.alarmIn(sid)) === null) { rested = true; break; }
    await tick();
  }

  h.shortcut.handle = handle;

  if (!rested) problems.push('the bridge never came to rest');
  for (const line of fake.misuse) problems.push(`fake: ${line}`);
  const logs = h.logs.slice(logged);
  for (const [level, message] of logs) if (level === 'error' && /step failed/.test(String(message)) && !answersLost) problems.push(`log: ${message}`);
  if (logs.some(([, message, detail]) => /step failed/.test(String(message)) && detail?.error === 'StalledError')) problems.push('a step stalled');
  const state = storage()?.data.get('state');
  if (state && state.phase.kind !== 'closed') {
    const working = fake.chats.filter((chat) => !chat.halted && (chat.opened !== null || chat.received.length));
    if (working.length > 1) problems.push(`two working conversations left: ${working.map((chat) => chat.id)}`);
    if (!fake.facts.linked && session().external_urls.length) problems.push('a card link was written for a backend without links');
    if (!fake.facts.linked && h.shortcut.activities(sid).some((a) => /\]\(/.test(a.content.body))) problems.push('link text in an activity for a backend without links');
  }

  for (const chat of fake.chats) {
    const heard = told.filter((each) => each.chat === chat);
    // A send that landed with its answer lost is sent again under a new key once its relay is dropped, as a reply is.
    // An introduction is not: the backend says the conversation holds it.
    const resent = heard.filter((each) => each.lost && !each.introduces && each.text.includes(CONTEXT_BLOCK)).length;
    const context = heard.reduce((sum, each) => sum + copies(each.text, CONTEXT_BLOCK), 0);
    if (context > 1 + resent) problems.push(`the context reached ${chat.id} ${context} times`);

    if (chat.key !== firstKey) continue;
    let has = false;
    for (const each of heard) {
      if (!has && knownBy(created, each.fixed) && !each.text.includes(CONTEXT_BLOCK)) problems.push(`${chat.id} was told ${JSON.stringify(each.text.slice(0, 40))} without the context it was owed`);
      has ||= each.text.includes(CONTEXT_BLOCK);
    }
  }
  for (const { at, turn } of stops) {
    for (const each of told.filter((each) => each.called > at)) {
      const cancelled = [...(each.text.includes(REQUEST) ? ['the opening request'] : []), ...turnsIn(each.text).filter((reply) => reply <= turn).map((reply) => `reply-${reply}`)];
      if (cancelled.length) problems.push(`${cancelled.join(' and ')} reached ${each.chat.id} after the stop of turn ${turn}`);
    }
  }
  const [first] = told;
  if (first && first.chat.key === firstKey && knownBy(created, first.fixed) && !stops.some(({ at }) => at < first.fixed) && turnDropped > first.fixed && !first.text.includes(REQUEST)) {
    problems.push('the opening request was dropped though nothing had reached the agent');
  }
  return { problems: [...new Set(problems)], trail };
}

it(`holds the core's invariants over ${RUNS} seeded runs of events, failures, and crashes in any order`, async (t) => {
  const failed = [];
  const h = bridge.setup(t);
  await h.connect();
  for (let seed = FROM; seed < FROM + RUNS; seed++) {
    const { problems, trail } = await run(t, h, seed);
    if (problems.length) failed.push({ seed, problems, trail });
  }
  const kinds = new Map();
  for (const { seed, problems } of failed) {
    for (const kind of new Set(problems.map((problem) => problem.replace(/[0-9]+/g, 'N').replace(/"[^"]*"/g, '"…"')))) kinds.set(kind, [...(kinds.get(kind) ?? []), seed]);
  }
  const report = [...kinds].map(([kind, seeds]) => `${seeds.length} run${seeds.length === 1 ? '' : 's'}: ${kind} (seeds ${seeds.slice(0, 8).join(', ')})`);
  const shown = failed.find(({ seed }) => String(seed) === process.env.FUZZ_SHOW);
  if (shown) process.stdout.write(`${shown.problems.join('\n')}\n${shown.trail.join('\n')}\n`);
  assert.deepEqual(report, [], 'every run keeps every invariant. Rerun one seed with FUZZ_SEED=<seed> FUZZ_RUNS=1 FUZZ_SHOW=<seed>.');
});
