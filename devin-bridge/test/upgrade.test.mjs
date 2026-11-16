import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { it } from 'node:test';
import { pathToFileURL } from 'node:url';

// Set by fixtures/record.mjs to a copy of the bridge before the backend port.
// This file then records the states that code stores instead of testing.
const RECORD_FROM = process.env.RECORD_FROM;
const { SID, setup } = await import(RECORD_FROM ? pathToFileURL(`${RECORD_FROM}/test/harness.mjs`).href : './harness.mjs');
const FIXTURES = new URL('./fixtures/pre-port-states.json', import.meta.url);
const EPOCH = Date.UTC(2026, 9, 1, 12);

const deliver = (make) => async (h, w) => assert.equal((await h.deliver(make(h, w))).status, 200);
const open = deliver((h) => h.shortcut.open());
const reply = (text) => deliver((h) => h.shortcut.prompt(SID, text));
const stop = deliver((h) => h.shortcut.stop(SID));
const tick = (h) => h.tick();
const ticks = (n) => Array(n).fill(tick);
const devin = (h, n) => h.devin.sessions[n - 1];
const status = (n, value, detail = null) => (h) => Object.assign(devin(h, n), { status: value, status_detail: detail });
const says = (n, text) => (h) => h.devin.say(devin(h, n), text);
const fails = (code, call, headers = {}) => (h) => h.devin.failNext(code, headers, call);

const responses = (h) => h.shortcut.activities().filter((a) => a.content.type === 'response').map((a) => [a.turn, a.content.body.split('\n')[0]]);

const scenarios = [
  {
    name: 'an answered session is replied to',
    steps: [
      (h) => h.connect(), open, tick,
      status(1, 'running', 'working'), says(1, 'Looking into it'), tick,
      ...ticks(13),
      status(1, 'running', 'finished'), says(1, 'Turn one answer'), tick,
      reply('More (private-prompt)'), tick, tick,
      status(1, 'running', 'working'), says(1, 'Working on more'), tick,
      status(1, 'running', 'finished'), says(1, 'Turn two answer'), tick, tick,
    ],
    outcome(h) {
      assert.equal(h.devin.sessions.length, 1, 'the reply goes to the same Devin session');
      assert.deepEqual(devin(h, 1).received, ['More (private-prompt)']);
      assert.deepEqual(responses(h), [[1, 'Turn one answer'], [2, 'Turn two answer']], 'each answer is posted once, on its own turn');
    },
  },
  {
    name: 'a relay is retried before and after its baseline',
    steps: [
      (h) => h.connect(), open, tick,
      status(1, 'running', 'finished'), says(1, 'First answer'), tick,
      (h, w) => { w.two = h.shortcut.prompt(SID, 'Fix Firefox (private-prompt)'); w.three = h.shortcut.prompt(SID, 'Also add tests (private-prompt)'); },
      deliver((h, w) => w.three), deliver((h, w) => w.two), fails(503, /^GET .*\/sessions\/devin-1$/), tick,
      fails(503, /^POST .*\/messages$/), tick,
      tick,
      tick,
      status(1, 'running', 'working'), tick,
      status(1, 'running', 'finished'), tick, tick,
    ],
    outcome(h) {
      assert.deepEqual(devin(h, 1).received, ['Fix Firefox (private-prompt)\n\nAlso add tests (private-prompt)']);
      assert.deepEqual(responses(h), [[1, 'First answer'], [3, 'Devin finished.']]);
    },
  },
  {
    name: 'Devin does not pick up a reply',
    steps: [
      (h) => h.connect(), open, tick,
      status(1, 'running', 'finished'), says(1, 'First answer'), tick,
      reply('Hello? (private-prompt)'), tick,
      ...ticks(14),
      reply('Again (private-prompt)'), tick,
      status(1, 'running', 'working'), says(1, 'Back'), tick,
      status(1, 'running', 'finished'), tick, tick,
    ],
    outcome(h) {
      assert.deepEqual(devin(h, 1).received, ['Hello? (private-prompt)', 'Again (private-prompt)']);
      assert.deepEqual(h.shortcut.activities().filter((a) => a.content.type === 'error').map((a) => [a.turn, a.content.body.split(' [')[0]]), [[2, 'Devin did not pick up your reply. Reply to try again.']]);
      assert.deepEqual(responses(h), [[1, 'First answer'], [3, 'Back']]);
    },
  },
  {
    name: 'an answer is placed after the relayed reply, not after other messages',
    steps: [
      (h) => h.connect(), open, tick,
      status(1, 'running', 'finished'), says(1, 'First answer'), tick,
      reply('More (private-prompt)'), fails(503, /^POST .*\/messages$/), tick,
      (h) => { devin(h, 1).messages.push({ event_id: 'typed-1', source: 'user', message: 'Typed in Devin', created_at: 0 }); h.devin.say(devin(h, 1), 'Reply to the typed message'); },
      tick,
      tick,
      status(1, 'running', 'working'), says(1, 'Answer to more'), tick,
      status(1, 'running', 'finished'), tick,
      reply('More (private-prompt)'), tick,
      tick,
      says(1, 'Second answer to more'), tick, tick,
    ],
    outcome(h) {
      assert.deepEqual(devin(h, 1).received, ['More (private-prompt)', 'More (private-prompt)']);
      assert.deepEqual(responses(h), [[1, 'First answer'], [2, 'Answer to more'], [3, 'Second answer to more']]);
    },
  },
  {
    name: 'replies and the session.created delivered out of order',
    steps: [
      (h) => h.connect(),
      (h, w) => { w.created = h.shortcut.open(); w.two = h.shortcut.prompt(SID, 'Second (private-prompt)'); w.three = h.shortcut.prompt(SID, 'Third (private-prompt)'); },
      fails(503, /^POST .*\/sessions$/), deliver((h, w) => w.three), tick,
      deliver((h, w) => w.two), tick,
      fails(503, /^POST .*\/messages$/), tick,
      deliver((h, w) => w.created), tick,
      tick,
      status(1, 'running', 'working'), says(1, 'Working'), tick,
      (h, w) => { w.four = h.shortcut.prompt(SID, 'Fourth (private-prompt)'); w.five = h.shortcut.prompt(SID, 'Fifth (private-prompt)'); },
      deliver((h, w) => w.five), tick,
      (h, w) => { w.six = h.shortcut.prompt(SID, 'Sixth (private-prompt)'); },
      deliver((h, w) => w.six), fails(503, /^GET .*\/sessions\/devin-1$/), tick,
      deliver((h, w) => w.four), tick,
      tick,
      status(1, 'running', 'finished'), says(1, 'All done'), tick, tick,
    ],
    outcome(h) {
      assert.match(devin(h, 1).prompt, /Third \(private-prompt\)/);
      assert.equal(devin(h, 1).received.length, 4);
      assert.equal(devin(h, 1).received[0], 'Second (private-prompt)');
      assert.match(devin(h, 1).received[1], /^Please fix the Safari login bug/);
      assert.deepEqual(devin(h, 1).received.slice(2), ['Fifth (private-prompt)', 'Sixth (private-prompt)']);
      assert.deepEqual(responses(h), [[6, 'All done']]);
    },
  },
  {
    name: 'a reply delivered after the stop that cancelled it',
    steps: [
      (h) => h.connect(), open, tick,
      status(1, 'running', 'working'), (h, w) => { w.cancelled = h.shortcut.prompt(SID, 'Cancelled reply (private-prompt)'); }, stop, tick,
      tick,
      (h, w) => { w.fresh = h.shortcut.prompt(SID, 'Fresh start (private-prompt)'); }, deliver((h, w) => w.fresh), deliver((h, w) => w.cancelled), tick,
      status(2, 'running', 'finished'), says(2, 'Fresh answer'), tick, tick,
    ],
    outcome(h) {
      assert.doesNotMatch(devin(h, 2).prompt, /Cancelled reply/);
      assert.match(devin(h, 2).prompt, /Fresh start/);
      assert.deepEqual(responses(h), [[2, `Stopped. The Devin session was terminated: ${devin(h, 1).url}`], [3, 'Fresh answer']]);
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
      assert.match(devin(h, 1).received[0], /Login fails on Safari\.[^]*Next \(private-prompt\)$/);
      assert.deepEqual(responses(h), [[2, 'First answer'], [3, 'Second answer']]);
    },
  },
  {
    name: 'a late session.created relays the opening request',
    steps: [
      (h) => h.connect(), (h, w) => { w.created = h.shortcut.open(); }, reply('Pick this up (private-prompt)'), tick,
      status(1, 'running', 'working'), deliver((h, w) => w.created), tick,
      tick,
      says(1, 'Done'), status(1, 'running', 'finished'), tick, tick,
    ],
    outcome(h) {
      assert.equal(devin(h, 1).received.length, 1);
      assert.match(devin(h, 1).received[0], /Please fix the Safari login bug/);
      assert.deepEqual(responses(h), [[2, 'Done']]);
    },
  },
  {
    name: 'a stop waits out a failed terminate',
    steps: [
      (h) => h.connect(), open, tick,
      status(1, 'running', 'working'), says(1, 'Working'), stop, fails(503, /^DELETE /), tick,
      tick,
      reply('Try again (private-prompt)'), tick,
      status(2, 'running', 'finished'), says(2, 'Second session answer'), tick, tick,
    ],
    outcome(h) {
      assert.equal(devin(h, 1).terminated, true);
      assert.deepEqual(devin(h, 2).tags, ['shortcut-session-sess-1-2']);
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
    name: 'a stop after a lost create terminates the session under the tag',
    steps: [
      (h) => h.connect(), (h) => { h.devin.state.loseCreate = true; }, open, tick,
      stop, tick,
      tick,
      reply('Again (private-prompt)'), tick,
      status(2, 'running', 'finished'), says(2, 'Answer'), tick, tick,
    ],
    outcome(h) {
      assert.equal(devin(h, 1).terminated, true);
      assert.deepEqual(responses(h), [[1, `Stopped. The Devin session was terminated: ${devin(h, 1).url}`], [2, 'Answer']]);
    },
  },
  {
    name: 'a reply to a Devin session that ended retires it and starts another',
    steps: [
      (h) => h.connect(), open, tick,
      status(1, 'running', 'finished'), says(1, 'Answer'), tick,
      status(1, 'exit'), reply('More (private-prompt)'), fails(503, /^DELETE /), tick,
      tick,
      status(2, 'running', 'finished'), says(2, 'Fresh answer'), tick, tick,
    ],
    outcome(h) {
      assert.equal(devin(h, 1).terminated, true);
      assert.deepEqual(devin(h, 1).received, []);
      assert.match(devin(h, 2).prompt, /More \(private-prompt\)/);
      assert.deepEqual(responses(h), [[1, 'Answer'], [2, 'Fresh answer']]);
    },
  },
  {
    name: 'Shortcut and Devin failures set their own deadlines',
    steps: [
      (h) => h.connect(), (h) => { h.shortcut.state.serverErrors = 1; h.shortcut.state.readFailures.push(503); }, open, tick,
      tick,
      tick,
      (h) => { h.shortcut.state.rateLimits.push('3'); }, status(1, 'running', 'working'), says(1, 'Progress'), tick,
      tick,
      fails(429, /^GET /, { 'Retry-After': '7' }), tick,
      tick,
      status(1, 'running', 'finished'), says(1, 'Done'), tick, tick,
    ],
    outcome(h) {
      assert.deepEqual(h.shortcut.activities().map((a) => [a.turn, a.content.type, a.content.body.split('\n')[0]]),
        [[1, 'thought', 'Starting a Devin session.'], [1, 'thought', 'Progress'], [1, 'response', 'Done']]);
      assert.deepEqual(h.shortcut.sessions.get(SID).external_urls, [{ label: 'Open in Devin', url: devin(h, 1).url }]);
    },
  },
  {
    name: 'Devin asks for an approval, then a reply',
    steps: [
      (h) => h.connect(), open, tick,
      status(1, 'running', 'waiting_for_approval'), says(1, 'Approve the deploy?'), tick,
      tick,
      status(1, 'running', 'waiting_for_user'), says(1, 'Which browser?'), tick,
      reply('Safari (private-prompt)'), tick,
      tick,
      status(1, 'running', 'working'), tick,
      (h) => { devin(h, 1).pull_requests = ['https://github.com/acme/app/pull/1']; }, status(1, 'running', 'finished'), says(1, 'Fixed'), tick, tick,
    ],
    outcome(h) {
      assert.deepEqual(devin(h, 1).received, ['Safari (private-prompt)']);
      assert.deepEqual(h.shortcut.activities().filter((a) => a.content.type === 'elicitation').map((a) => a.content.body.split('\n')[0]), ['Approve the deploy?', 'Which browser?']);
      assert.deepEqual(responses(h), [[2, 'Fixed']]);
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
];

const clone = (value) => (value === undefined ? undefined : structuredClone(value));

async function run(t, scenario, upgrade = null) {
  const h = setup(t);
  t.mock.timers.setTime(EPOCH);
  const w = {};
  const trace = [];
  const stored = [];
  const storage = () => h.env.SESSIONS.storages.get(SID);
  const replace = () => {
    storage().data.set('state', clone(upgrade.state));
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
    if (upgrade?.step === step && upgrade.at === 'inbox') replace();
    await act(h, w);
    if (upgrade?.step === step && upgrade.at === 'rest') replace();
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

function variants({ phase, retire, outbox, late, failures, notBefore }) {
  const found = [];
  switch (phase.kind) {
    case 'start': found.push(phase.attempted ? 'start, attempted' : 'start'); break;
    case 'relay': found.push(phase.send ? 'relay, prepared' : 'relay'); if (phase.send?.late) found.push('relay, prepared with a late context'); break;
    case 'poll': found.push(phase.relayed === null ? 'poll, nothing relayed' : phase.relayed.heard ? 'poll, reply heard' : 'poll, reply not heard'); break;
    case 'stop': found.push(phase.target ? `stop, ${phase.target.kind} target` : 'stop, no target'); if (phase.then.length) found.push('stop, with replies'); break;
    case 'idle': found.push(phase.link ? 'idle, linked' : 'idle, no link'); break;
    case 'closed': found.push('closed'); break;
  }
  const pending = [...(phase.prompt ?? []), ...(phase.extra ?? []), ...(phase.then ?? []), ...(phase.send?.prompt ?? [])];
  if (pending.some((p) => p.opening)) found.push('opening request');
  for (const target of retire) found.push(`retire, ${target.kind}`);
  if (outbox.length) found.push('outbox');
  if (late) found.push('late context');
  for (const job of Object.keys(failures)) {
    if (failures[job]) found.push(`failures.${job}`);
    if (notBefore[job] !== null) found.push(`notBefore.${job}`);
  }
  return found;
}

const REQUIRED = [
  'start', 'start, attempted', 'relay', 'relay, prepared', 'relay, prepared with a late context', 'opening request',
  'poll, nothing relayed', 'poll, reply not heard', 'poll, reply heard',
  'stop, live target', 'stop, unresolved target', 'stop, no target', 'stop, with replies',
  'idle, linked', 'idle, no link', 'closed', 'retire, live', 'retire, unresolved', 'outbox', 'late context',
  ...['devin', 'shortcut', 'retire', 'link'].flatMap((job) => [`failures.${job}`, `notBefore.${job}`]),
];

if (RECORD_FROM) {
  it('records the states the code before the backend port stores', async (t) => {
    const recorded = {};
    for (const scenario of scenarios) {
      await t.test(scenario.name, async (t) => {
        const { h, stored } = await run(t, scenario);
        scenario.outcome(h);
        recorded[scenario.name] = distinct(stored);
      });
    }
    assert.deepEqual(Object.keys(recorded), scenarios.map((s) => s.name), 'every scenario reaches its outcome on the code before the port');
    // One state per line, so the file stays short enough to review and a changed state shows as one changed line.
    const lines = Object.entries(recorded).map(([name, states]) => `${JSON.stringify(name)}: [\n${states.map((s) => `  ${JSON.stringify(s)}`).join(',\n')}\n]`);
    await writeFile(FIXTURES, `{\n${lines.join(',\n')}\n}\n`);
  });
} else {
  const fixtures = JSON.parse(await readFile(FIXTURES, 'utf8'));

  it('has a recorded state for every phase and variant the code before the port stored', () => {
    assert.deepEqual(Object.keys(fixtures), scenarios.map((s) => s.name));
    const covered = new Set(Object.values(fixtures).flat().flatMap(({ state }) => variants(state)));
    assert.deepEqual(REQUIRED.filter((variant) => !covered.has(variant)), []);
  });

  for (const scenario of scenarios) {
    it(`continues from each recorded state as if never upgraded: ${scenario.name}`, async (t) => {
      let whole;
      await t.test('without an upgrade', async (t) => {
        whole = await run(t, scenario);
        scenario.outcome(whole.h);
      });
      for (const upgrade of fixtures[scenario.name]) {
        await t.test(`after step ${upgrade.step}, ${upgrade.at}: ${variants(upgrade.state).join('; ')}`, async (t) => {
          const resumed = await run(t, scenario, upgrade);
          const from = upgrade.at === 'rest' ? upgrade.step + 1 : upgrade.step;
          assert.deepEqual(resumed.trace.slice(from), whole.trace.slice(from));
          scenario.outcome(resumed.h);
          resumed.h.assertCleanLogs();
        });
      }
    });
  }

  it('relays a reply to an idle session upgraded before it to the same Devin session, and posts the earlier answer only once', async (t) => {
    const [scenario] = scenarios;
    const idle = fixtures[scenario.name].find(({ state }) => state.phase.kind === 'idle');
    const { h } = await run(t, scenario, idle);
    scenario.outcome(h);
  });

  it('keeps a poll stored before heartbeats existed, and reports a quiet session on its next poll', async (t) => {
    const [scenario] = scenarios;
    const poll = fixtures[scenario.name].find(({ state }) => state.phase.kind === 'poll' && state.phase.posted !== null);
    const { heartbeatAt, ...phase } = poll.state.phase;
    const { h, trace } = await run(t, scenario, { ...poll, state: { ...poll.state, phase } });
    assert.deepEqual(trace.flatMap(({ logs }) => logs).filter(([level]) => level === 'warn'), []);
    const heartbeats = h.shortcut.activities().filter((a) => a.content.type === 'thought' && a.content.body === 'Looking into it');
    assert.ok(heartbeats.length >= 2, 'the quiet session is reported again without waiting out a heartbeat interval');
    scenario.outcome(h);
    h.assertCleanLogs();
  });

  it('drops a stored state it cannot read with one warning that names only the session', async (t) => {
    const [scenario] = scenarios;
    const idle = fixtures[scenario.name].find(({ state }) => state.phase.kind === 'idle');
    const garbled = { ...idle.state, phase: { ...idle.state.phase, kind: 'waiting (private-state)' } };
    const { h, trace } = await run(t, scenario, { ...idle, state: garbled });
    const warnings = trace.flatMap(({ logs }) => logs).filter(([level]) => level === 'warn');
    assert.deepEqual(warnings, [['warn', 'Devin Bridge dropped a stored session state of an older shape', { sessionId: SID }]]);
    h.assertCleanLogs();
  });
}
