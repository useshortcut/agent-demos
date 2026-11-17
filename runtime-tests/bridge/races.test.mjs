// Races between Shortcut's events and a step that is already running, against
// fake-backend.ts. Runs in the `npm test` of the bridge in the current
// directory, against its src/core. exhaust.mjs searches the same races. Each
// test here shows one as a user would meet it.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { SID, bridgeHarness } from './harness.mjs';

const root = pathToFileURL(`${process.cwd()}/`);
assert.ok(existsSync(new URL('src/core/port.ts', root)), 'races.test.mjs tests the bridge in the current directory. Run `npm test` inside a bridge.');

const bridge = await bridgeHarness({
  root,
  secrets: {},
  sensitive: /private|token-\d|refresh-\d/,
  backend: new URL('./fake-backend.ts', import.meta.url),
  vendor: { env: {}, mock: (log) => bridge.mod.backend.script(log) },
});
const { BackendError } = bridge.mod;

function setup(t) {
  const h = bridge.setup(t);
  h.env.FAKE = h.vendor;
  t.after(() => assert.deepEqual(h.vendor.misuse, []));
  return Object.assign(h, {
    fake: h.vendor,
    calls: (method) => h.requests.filter((r) => r.origin === 'fake' && r.method === method),
    accept: async (event) => assert.equal((await h.deliver(event)).status, 200),
    bodies: (type) => h.shortcut.activities().filter((a) => a.content.type === type).map((a) => a.content.body),
  });
}

/** Shortcut delivers `event`, and has the bridge's 200, while the next `call` of `target` is out. */
function arrivesDuring(h, target, call, event) {
  const run = target[call];
  target[call] = async (...args) => {
    target[call] = run;
    const answer = await run.apply(target, args);
    await h.accept(event);
    return answer;
  };
}

it('applies a stop that arrives while a step waits on the backend before the step\'s next call, so the reply it cancels is never sent', async (t) => {
  const h = setup(t);
  const chat = await h.started();
  await h.accept(h.shortcut.prompt(SID, 'cancel this reply'));
  arrivesDuring(h, h.fake.backend, 'prepare', h.shortcut.stop(SID));
  await h.tick();
  assert.deepEqual(chat.received, [], 'the stop was acknowledged before the send went out');
  assert.equal(chat.halted, true, 'the step that was running halts the conversation');
  assert.deepEqual(h.bodies('response'), [`Stopped. The Fake session was terminated: ${chat.url}`]);
  assert.equal(await h.alarmIn(), null);
  h.assertCleanLogs();
});

it('applies a stop that arrives while a step loads the Shortcut credentials before the send that step was about to retry', async (t) => {
  const h = setup(t);
  const chat = await h.started();
  await h.accept(h.shortcut.prompt(SID, 'cancel this reply'));
  h.fake.failNext('send', new BackendError({ kind: 'transient' }));
  await h.tick();
  assert.deepEqual([h.calls('send').length, chat.received], [1, []], 'the send is prepared and has failed once');

  const workspaces = h.env.WORKSPACES;
  const { get } = workspaces;
  workspaces.get = (id) => {
    workspaces.get = get;
    const workspace = get(id);
    arrivesDuring(h, workspace, 'fetch', h.shortcut.stop(SID));
    return workspace;
  };
  await h.tick();
  assert.deepEqual([h.calls('send').length, chat.received], [1, []], 'the send is not tried again');
  assert.equal(chat.halted, true);
  h.assertCleanLogs();
});
