import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { it } from 'node:test';
import { pathToFileURL } from 'node:url';

// Set by fixtures/record-first-port.mjs to a copy of the bridge as its backend
// port first stored states. This file then records the states that code
// stores instead of testing.
const RECORD_FROM = process.env.RECORD_FROM;
const { SID, setup } = await import(RECORD_FROM ? pathToFileURL(`${RECORD_FROM}/test/harness.mjs`).href : './harness.mjs');
const FIXTURES = new URL('./fixtures/first-port-states.json', import.meta.url);
const EPOCH = Date.UTC(2026, 9, 1, 12);

const deliver = (make) => async (h, w) => assert.equal((await h.deliver(make(h, w))).status, 200);
const open = deliver((h) => h.shortcut.open());
const reply = (text) => deliver((h) => h.shortcut.prompt(SID, text));
const stop = deliver((h) => h.shortcut.stop(SID));
const tick = (h) => h.tick();
const devin = (h, n) => h.devin.sessions[n - 1];
const status = (n, value, detail = null) => (h) => Object.assign(devin(h, n), { status: value, status_detail: detail });
const says = (n, text) => (h) => h.devin.say(devin(h, n), text);
const fails = (code, call) => (h) => h.devin.failNext(code, {}, call);

const responses = (h) => h.shortcut.activities().filter((a) => a.content.type === 'response').map((a) => [a.turn, a.content.body.split('\n')[0]]);

const scenarios = [
  {
    name: 'a relay is retried before and after it is prepared',
    steps: [
      (h) => h.connect(), open, tick,
      status(1, 'running', 'finished'), says(1, 'First answer'), tick,
      reply('Fix Firefox (private-prompt)'), fails(503, /^GET .*\/sessions\/devin-1$/), tick,
      fails(503, /^POST .*\/messages$/), tick,
      tick,
      tick,
      status(1, 'running', 'working'), says(1, 'On it'), tick,
      status(1, 'running', 'finished'), says(1, 'Second answer'), tick, tick,
    ],
    outcome(h) {
      assert.deepEqual(devin(h, 1).received, ['Fix Firefox (private-prompt)'], 'a send prepared without a key still goes out, once');
      assert.deepEqual(responses(h), [[1, 'First answer'], [2, 'Second answer']]);
    },
  },
  {
    name: 'the session.created arrives after a reply opened the session',
    steps: [
      (h) => h.connect(),
      (h, w) => { w.created = h.shortcut.open(); w.two = h.shortcut.prompt(SID, 'Second (private-prompt)'); },
      fails(503, /^POST .*\/sessions$/), deliver((h, w) => w.two), tick,
      deliver((h, w) => w.created), tick,
      fails(503, /^POST .*\/messages$/), tick,
      tick,
      status(1, 'running', 'working'), says(1, 'Working'), tick,
      status(1, 'running', 'finished'), says(1, 'All done'), tick, tick,
    ],
    outcome(h) {
      assert.match(devin(h, 1).prompt, /Second \(private-prompt\)/);
      assert.equal(devin(h, 1).received.length, 1, 'the opening request is relayed as one message, not folded into an introduction');
      assert.match(devin(h, 1).received[0], /^Please fix the Safari login bug[^]*Context from Shortcut:[^]*Login fails on Safari\.$/);
      assert.deepEqual(responses(h), [[2, 'All done']]);
    },
  },
  {
    name: 'a late session.created leaves its context for the next reply',
    steps: [
      (h) => h.connect(), (h, w) => { w.created = h.shortcut.open(); }, reply('Pick this up (private-prompt)'), tick,
      status(1, 'running', 'finished'), says(1, 'First answer'), tick,
      deliver((h, w) => w.created), tick,
      reply('Next (private-prompt)'), fails(503, /^POST .*\/messages$/), tick,
      tick,
      status(1, 'running', 'working'), tick,
      status(1, 'running', 'finished'), says(1, 'Second answer'), tick, tick,
    ],
    outcome(h) {
      assert.equal(devin(h, 1).received.length, 1);
      assert.match(devin(h, 1).received[0], /^Context from Shortcut:[^]*Login fails on Safari\.[^]*Next \(private-prompt\)$/);
      assert.deepEqual(responses(h), [[2, 'First answer'], [3, 'Second answer']]);
    },
  },
  {
    name: 'a stop waits out a failed terminate, and the next reply starts a new session',
    steps: [
      (h) => h.connect(), open, tick,
      status(1, 'running', 'working'), says(1, 'Working'), stop, fails(503, /^DELETE /), tick,
      tick,
      reply('Try again (private-prompt)'), tick,
      status(2, 'running', 'finished'), says(2, 'Second session answer'), tick, tick,
    ],
    outcome(h) {
      assert.equal(devin(h, 1).terminated, true);
      assert.deepEqual(devin(h, 2).tags, ['shortcut-session-sess-1-2'], 'a conversation that ended is not kept for the reply');
      assert.deepEqual(responses(h), [[1, `Stopped. The Devin session was terminated: ${devin(h, 1).url}`], [2, 'Second session answer']]);
    },
  },
  {
    name: 'a stop before any Devin session exists looks for one under the tag',
    steps: [
      (h) => h.connect(), fails(503, /^POST .*\/sessions$/), open, tick,
      stop, fails(503, /^GET .*\/sessions$/), tick,
      tick,
      tick,
      tick,
      reply('Again (private-prompt)'), tick,
      status(1, 'running', 'finished'), says(1, 'Answer'), tick, tick,
    ],
    outcome(h) {
      assert.equal(h.devin.sessions.length, 1);
      assert.deepEqual(devin(h, 1).tags, ['shortcut-session-sess-1-2']);
      assert.deepEqual(responses(h), [[1, 'Stopped.'], [2, 'Answer']]);
    },
  },
  {
    name: 'a stop before the start, then a stop delivered after the next reply',
    steps: [
      (h) => h.connect(), open, stop, tick,
      reply('Begin again (private-prompt)'), tick,
      status(1, 'running', 'working'),
      (h, w) => { w.stop = h.shortcut.stop(SID); w.later = h.shortcut.prompt(SID, 'Actually do this (private-prompt)'); },
      deliver((h, w) => w.later), deliver((h, w) => w.stop), tick,
      tick,
      status(2, 'running', 'finished'), says(2, 'Did it'), tick, tick,
    ],
    outcome(h) {
      assert.equal(h.devin.sessions.length, 2);
      assert.equal(devin(h, 1).terminated, true);
      assert.match(devin(h, 2).prompt, /Actually do this/);
      assert.deepEqual(responses(h), [[1, 'Stopped.'], [3, 'Did it']]);
    },
  },
  {
    name: 'a session closed in Shortcut retires its Devin session',
    steps: [
      (h) => h.connect(), open, tick,
      status(1, 'running', 'working'), says(1, 'Progress'), (h) => { h.shortcut.sessions.get(SID).closed = true; }, fails(503, /^DELETE /), tick,
      tick,
      reply('Anyone there? (private-prompt)'), tick, tick,
    ],
    outcome(h) {
      assert.equal(devin(h, 1).terminated, true);
      assert.deepEqual(devin(h, 1).received, []);
    },
  },
  {
    // The first port put the context into the text of the late opening request, so the state that waits to replace the session holds it there.
    name: 'the session.created arrives after the session a reply opened has ended',
    steps: [
      (h) => h.connect(), (h, w) => { w.created = h.shortcut.open(); }, reply('Second (private-prompt)'), tick,
      status(1, 'exit'), deliver((h, w) => w.created), fails(429, /^DELETE /), tick,
      tick,
      status(2, 'running', 'finished'), says(2, 'Did both'), tick, tick,
    ],
    outcome(h) {
      assert.equal(h.devin.sessions.length, 2);
      assert.deepEqual(devin(h, 2).tags, ['shortcut-session-sess-1-2']);
      assert.match(devin(h, 2).prompt, /^A Shortcut user asked:\n\nPlease fix the Safari login bug[^]*Login fails on Safari\.$/);
      assert.deepEqual(responses(h), [[2, 'Did both']]);
    },
  },
];

const clone = (value) => (value === undefined ? undefined : structuredClone(value));

// Runs a scenario and records, per step, what the bridge did and every state
// it stored. With `resume`, the stored state is replaced by a recorded one at
// its step and the object restarts, as on a deploy at that moment.
async function run(t, scenario, resume = null) {
  const h = setup(t);
  t.mock.timers.setTime(EPOCH);
  const w = {};
  const trace = [];
  const stored = [];
  const storage = () => h.env.SESSIONS.storages.get(SID);
  const replace = () => {
    storage().data.set('state', clone(resume.state));
    h.env.SESSIONS.restart();
  };
  let watched = null;
  let current = 0;
  for (const [step, act] of scenario.steps.entries()) {
    current = step;
    const at = { requests: h.requests.length, logs: h.logs.length };
    const store = storage();
    if (store && store !== watched) {
      const put = store.put;
      store.put = async (key, value) => {
        // A state put while inbox keys remain was stored on applying the inbox, before any job ran.
        if (key === 'state' && [...store.data.keys()].some((k) => k.startsWith('inbox:'))) stored.push({ step: current, at: 'inbox', state: clone(value) });
        return put(key, value);
      };
      watched = store;
    }
    if (resume?.step === step && resume.at === 'inbox') replace();
    await act(h, w);
    if (resume?.step === step && resume.at === 'rest') replace();
    const state = storage()?.data.get('state');
    if (state !== undefined) stored.push({ step, at: 'rest', state: clone(state) });
    trace.push({ requests: clone(h.requests.slice(at.requests)), logs: JSON.parse(JSON.stringify(h.logs.slice(at.logs))), alarm: storage() ? await h.alarmIn() : null });
  }
  return { h, trace, stored };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function distinct(stored) {
  const seen = [];
  return stored.filter(({ state }) => !seen.some((s) => same(s, state)) && seen.push(state));
}

const pendings = ({ phase }) => [...(phase.prompt ?? []), ...(phase.extra ?? []), ...(phase.then ?? []), ...(phase.send?.prompt ?? [])];

function variants(state) {
  const { phase, retire, late } = state;
  const found = [];
  switch (phase.kind) {
    case 'start': found.push(phase.attempted ? 'start, attempted' : 'start'); break;
    case 'relay': found.push(phase.send ? 'relay, prepared' : 'relay'); if (phase.send?.late) found.push('relay, prepared with a late context'); break;
    case 'poll': found.push(phase.on.memo === null ? 'poll, nothing relayed' : 'poll, a reply relayed'); break;
    case 'stop': found.push(phase.target ? `stop, ${phase.target.kind} target` : 'stop, no target'); if (phase.then.length) found.push('stop, with replies'); break;
    case 'idle': found.push(phase.on ? 'idle, with a conversation' : 'idle, without one'); break;
    case 'closed': found.push('closed'); break;
  }
  if (pendings(state).some((p) => p.opening)) found.push('opening request');
  if (phase.kind === 'start' && !phase.attempted && phase.prompt.some((p) => p.opening)) found.push('start, replacing a conversation, with an opening request');
  for (const target of retire) found.push(`retire, ${target.kind}`);
  if (late) found.push('late context');
  return found;
}

const REQUIRED = [
  'start', 'start, attempted', 'start, replacing a conversation, with an opening request', 'relay', 'relay, prepared', 'relay, prepared with a late context', 'opening request',
  'poll, nothing relayed', 'poll, a reply relayed',
  'stop, live target', 'stop, unresolved target', 'stop, no target', 'stop, with replies',
  'idle, with a conversation', 'idle, without one', 'closed', 'retire, live', 'retire, unresolved', 'late context',
];

if (RECORD_FROM) {
  it('records the states the first backend port stores', async (t) => {
    const recorded = {};
    for (const scenario of scenarios) {
      await t.test(scenario.name, async (t) => {
        const { h, stored } = await run(t, scenario);
        scenario.outcome(h);
        recorded[scenario.name] = distinct(stored);
      });
    }
    assert.deepEqual(Object.keys(recorded), scenarios.map((s) => s.name), 'every scenario reaches its outcome on the first port');
    // One state per line, so a changed state shows as one changed line.
    const lines = Object.entries(recorded).map(([name, states]) => `${JSON.stringify(name)}: [\n${states.map((s) => `  ${JSON.stringify(s)}`).join(',\n')}\n]`);
    await writeFile(FIXTURES, `{\n${lines.join(',\n')}\n}\n`);
  });
} else {
  const fixtures = JSON.parse(await readFile(FIXTURES, 'utf8'));
  const states = Object.values(fixtures).flat().map(({ state }) => state);

  it('has a recorded state for every phase and variant, each in the shape the first port stored', () => {
    assert.deepEqual(Object.keys(fixtures), scenarios.map((s) => s.name));
    const covered = new Set(states.flatMap(variants));
    assert.deepEqual(REQUIRED.filter((variant) => !covered.has(variant)), []);
    assert.ok(states.every((state) => state.v === 2), 'every state is one the bridge loads without an upgrade');
    assert.ok(states.every((state) => 'late' in state && !('briefing' in state)), 'every state keeps the context it owes in `late`, not in `briefing`');
    const sends = states.map(({ phase }) => phase.send).filter(Boolean);
    assert.ok(sends.every((send) => 'late' in send && !('key' in send)), 'every prepared send has a `late` and no key');
  });

  it('saves a state the first port stored under today\'s tag, with one owner for the context, at its next step', async (t) => {
    const [scenario] = scenarios;
    const [resume] = fixtures[scenario.name];
    const { h } = await run(t, scenario, resume);
    const state = h.env.SESSIONS.storages.get(SID).data.get('state');
    assert.deepEqual([state.v, 'briefing' in state, 'late' in state], [3, true, false]);
  });

  for (const scenario of scenarios) {
    it(`continues from each state the first port stored as if it had stored it itself: ${scenario.name}`, async (t) => {
      let whole;
      await t.test('without a restart', async (t) => {
        whole = await run(t, scenario);
        scenario.outcome(whole.h);
      });
      for (const resume of fixtures[scenario.name]) {
        await t.test(`after step ${resume.step}, ${resume.at}: ${variants(resume.state).join('; ')}`, async (t) => {
          const resumed = await run(t, scenario, resume);
          const from = resume.at === 'rest' ? resume.step + 1 : resume.step;
          assert.deepEqual(resumed.trace.slice(from), whole.trace.slice(from));
          scenario.outcome(resumed.h);
          resumed.h.assertCleanLogs();
        });
      }
    });
  }
}
