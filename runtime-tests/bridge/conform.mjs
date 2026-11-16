// What every bridge owes Shortcut, whatever its backend. A bridge's suite
// calls conform() with its own harness and vendor mock, so each adapter is held
// to this one list. See ../README.md for the arguments.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { SID, openingText } from './harness.mjs';

const TICKS = 40;

export function conform({ label, setup, identity, facts, vendor }) {
  const { slug, name, aSession, linkLabel } = identity;
  const named = label ?? `${name} bridge`;

  /** Everything the session was told, oldest first, whether the open or a message carried it. */
  const heard = (h, session) => {
    const { opened, messages } = vendor.told(h, session);
    return opened === null ? messages : [opened, ...messages];
  };
  const link = (session) => (facts.linked ? `[${linkLabel}](${vendor.url(session)})` : '');
  const under = (body, session) => [body, link(session)].filter(Boolean).join('\n\n');
  const activities = (h, type) => h.shortcut.activities().filter((a) => a.content.type === type);
  const answers = (h) => activities(h, 'response').map((a) => [a.turn, a.content.body.split('\n')[0]]);
  const deliver = async (h, event) => assert.equal((await h.deliver(event)).status, 200);
  /** How many requests the bridge has made of its backend. */
  const asked = (h) => h.requests.filter((r) => r.origin !== 'shortcut').length;
  const settle = async (h) => { for (let i = 0; i < 4; i++) await h.tick(); };

  // Each alarm runs at its scheduled time, so this also moves the clock through the bridge's waits.
  async function until(h, reached, what) {
    for (let i = 0; i < TICKS && !reached(); i++) await h.tick();
    assert.ok(reached(), `${what} within ${TICKS} alarms`);
  }

  async function opened(h, created = h.shortcut.open()) {
    await h.connect();
    await deliver(h, created);
    await until(h, () => vendor.sessions(h).length > 0 && heard(h, vendor.sessions(h)[0]).length > 0, 'the bridge opens a session and tells it the request');
    return vendor.sessions(h)[0];
  }

  async function answered(h, session, text) {
    vendor.work(h, session);
    vendor.say(h, session, text);
    vendor.finish(h, session);
    await until(h, () => answers(h).some(([, line]) => line === text), `the bridge posts the answer "${text}"`);
  }

  const scenario = (title, run) => it(`${named}: ${title}`, async (t) => {
    const h = setup(t);
    await run(h);
    h.assertCleanLogs();
  });

  scenario('opens one session and tells it the request, the story link, and the context once', async (h) => {
    const session = await opened(h);
    assert.equal(vendor.sessions(h).length, 1);
    assert.deepEqual(heard(h, session), [openingText()]);
    assert.equal(vendor.told(h, session).opened === null, facts.opensEmpty, facts.opensEmpty ? 'the session is created empty and its first message carries the opening text' : 'the create carries the opening text');
    const [ack] = h.shortcut.activities();
    assert.deepEqual([ack.key, ack.turn, ack.content, ack.ephemeral], [`${slug}:1:ack`, 1, { type: 'thought', body: `Starting ${aSession}.` }, true]);
    assert.deepEqual(h.shortcut.sessions.get(SID).external_urls, facts.linked ? [{ label: linkLabel, url: vendor.url(session) }] : []);
  });

  scenario('posts the agent\'s newest message as progress while it works', async (h) => {
    const session = await opened(h);
    vendor.work(h, session);
    vendor.say(h, session, 'Reading the code');
    vendor.say(h, session, 'Looking into it');
    await until(h, () => activities(h, 'thought').some((a) => a.content.body === 'Looking into it'), 'the bridge posts the newer of two messages the agent sent between two reads');
    const progress = activities(h, 'thought').find((a) => a.content.body === 'Looking into it');
    assert.deepEqual([progress.turn, progress.ephemeral], [1, true]);
    assert.deepEqual(h.shortcut.activities().filter((a) => a.content.type !== 'thought'), [], 'progress does not end the turn');
  });

  scenario('posts the agent\'s last message as the response when it finishes', async (h) => {
    const session = await opened(h);
    vendor.work(h, session);
    vendor.say(h, session, 'Found the cause');
    await answered(h, session, 'Fixed it');
    assert.deepEqual(activities(h, 'response').map((a) => [a.turn, a.content.body]), [[1, under('Fixed it', session)]], 'the response is the last of the messages the agent sent, not the first');
    assert.deepEqual(activities(h, 'error'), []);
  });

  scenario('sends a reply to the same session and answers it on its own turn', async (h) => {
    const session = await opened(h);
    await answered(h, session, 'Fixed it');
    await deliver(h, h.shortcut.prompt(SID, 'Also fix Firefox'));
    await until(h, () => heard(h, session).length === 2, 'the bridge sends the reply');
    assert.equal(vendor.sessions(h).length, 1);
    assert.deepEqual(heard(h, session), [openingText(), 'Also fix Firefox']);
    await settle(h);
    assert.deepEqual(h.shortcut.activities().filter((a) => a.turn === 2).map((a) => [a.key, a.content.body]), [[`${slug}:2:ack`, `Passing your message to ${name}.`]],
      'until the agent acts on the reply, the backend still shows the turn before, and none of that is posted as this turn\'s progress or outcome');
    await answered(h, session, 'Fixed Firefox too');
    assert.deepEqual(answers(h), [[1, 'Fixed it'], [2, 'Fixed Firefox too']]);
  });

  scenario('asks the agent\'s question, hands the turn back, and passes the answer to the same session', async (h) => {
    const session = await opened(h);
    vendor.ask(h, session, 'Which browser?');
    await until(h, () => activities(h, 'elicitation').length > 0, 'the bridge asks the question');
    assert.deepEqual(activities(h, 'elicitation').map((a) => [a.turn, a.content.body]), [[1, under('Which browser?', session)]]);
    assert.deepEqual(answers(h), [], 'a question is not an answer');
    await settle(h);
    const before = asked(h);
    await settle(h);
    assert.equal(asked(h), before, 'the turn is handed back, so the bridge asks the backend nothing more until a reply arrives');
    await deliver(h, h.shortcut.prompt(SID, 'Safari'));
    await until(h, () => heard(h, session).length === 2, 'the bridge passes the answer back');
    assert.equal(vendor.sessions(h).length, 1);
    assert.deepEqual(heard(h, session), [openingText(), 'Safari']);
    await answered(h, session, 'Fixed Safari');
    assert.deepEqual(answers(h), [[2, 'Fixed Safari']]);
  });

  scenario('ends the turn with an error when the session fails, and the next reply still reaches an agent', async (h) => {
    const session = await opened(h);
    vendor.fail(h, session);
    await until(h, () => activities(h, 'error').length > 0, 'the bridge reports the failure');
    assert.deepEqual(activities(h, 'error').map((a) => a.turn), [1]);
    assert.deepEqual(answers(h), []);
    await deliver(h, h.shortcut.prompt(SID, 'Try again'));
    const told = () => vendor.sessions(h).flatMap((each) => heard(h, each)).filter((text) => text.includes('Try again'));
    await until(h, () => told().length > 0, 'the bridge sends the next reply somewhere');
    assert.equal(told().length, 1);
  });

  scenario(`stops the work, answers "Stopped.", and sends the next reply to ${facts.keeps ? 'the same session' : 'a new session'}`, async (h) => {
    const session = await opened(h);
    vendor.work(h, session);
    await deliver(h, h.shortcut.stop(SID));
    await until(h, () => answers(h).length > 0, 'the bridge answers the stop');
    assert.equal(vendor.halted(h, session), true);
    assert.equal(vendor.takes(h, session), facts.keeps, facts.keeps ? 'the backend still takes a message for the stopped session' : 'the backend takes no more messages for the stopped session');
    const stopped = facts.keeps || !facts.linked ? 'Stopped.' : `Stopped. The ${name} session was terminated: ${vendor.url(session)}`;
    assert.deepEqual(activities(h, 'response').map((a) => [a.turn, a.content.body]), [[1, stopped]]);

    await deliver(h, h.shortcut.prompt(SID, 'Try Chrome instead'));
    await until(h, () => vendor.sessions(h).some((each) => heard(h, each).some((text) => text.includes('Try Chrome instead'))), 'the bridge sends the reply after the stop');
    const sessions = vendor.sessions(h);
    if (facts.keeps) {
      assert.equal(sessions.length, 1, 'a kept session takes the reply');
      assert.deepEqual(heard(h, session), [openingText(), 'Try Chrome instead']);
    } else {
      assert.equal(sessions.length, 2, 'a session that ended is replaced');
      assert.deepEqual(heard(h, session), [openingText()]);
      assert.deepEqual(heard(h, sessions[1]), [openingText('Try Chrome instead')], 'the new session is told the reply, the story link, and the context');
    }
    await answered(h, sessions.at(-1), 'Chrome works');
    assert.deepEqual(answers(h), [[1, stopped], [2, 'Chrome works']]);
  });

  scenario('halts the session when Shortcut closes it, and ignores what follows', async (h) => {
    const session = await opened(h);
    vendor.work(h, session);
    vendor.say(h, session, 'Working on it');
    h.shortcut.sessions.get(SID).closed = true;
    await until(h, () => vendor.halted(h, session), 'the bridge halts the session');
    await deliver(h, h.shortcut.prompt(SID, 'Anyone there?'));
    for (let i = 0; i < 3; i++) await h.tick();
    assert.equal(vendor.sessions(h).length, 1);
    assert.deepEqual(heard(h, session), [openingText()]);
  });

  scenario('tells one session the opening text, once, when an open reaches the backend and its answer is lost', async (h) => {
    await h.connect();
    vendor.lose(h, 'open');
    await deliver(h, h.shortcut.open());
    const told = () => vendor.sessions(h).filter((each) => heard(h, each).length > 0);
    await until(h, () => told().length > 0, 'the bridge tells a session the request');
    await settle(h);
    assert.equal(told().length, 1, 'the lost open may leave an empty session behind, and no second session is told anything');
    assert.deepEqual(heard(h, told()[0]), [openingText()]);
  });

  scenario(`delivers a reply ${facts.dedupes ? 'once' : 'no more than twice'} when its send reaches the backend and the answer is lost`, async (h) => {
    const session = await opened(h);
    await answered(h, session, 'Fixed it');
    vendor.lose(h, 'send');
    await deliver(h, h.shortcut.prompt(SID, 'Also fix Firefox'));
    await until(h, () => heard(h, session).includes('Also fix Firefox'), 'the bridge sends the reply');
    await settle(h);
    const copies = heard(h, session).filter((text) => text === 'Also fix Firefox').length;
    if (facts.dedupes) assert.equal(copies, 1, 'the backend takes the send key, so the repeated send is the same send');
    else assert.ok(copies === 1 || copies === 2, `the backend has no send key, so the one repeat may be delivered, and nothing after it. Delivered ${copies} times.`);
    assert.equal(vendor.sessions(h).length, 1);
    await answered(h, session, 'Fixed Firefox too');
    assert.deepEqual(answers(h), [[1, 'Fixed it'], [2, 'Fixed Firefox too']]);
  });

  scenario('opens no second session and sends nothing twice when Shortcut delivers an event again', async (h) => {
    const created = h.shortcut.open();
    const session = await opened(h, created);
    await deliver(h, created);
    const reply = h.shortcut.prompt(SID, 'Also fix Firefox');
    await deliver(h, reply);
    await deliver(h, reply);
    await until(h, () => heard(h, session).length === 2, 'the bridge sends the reply');
    await deliver(h, created);
    await deliver(h, reply);
    for (let i = 0; i < 3; i++) await h.tick();
    assert.equal(vendor.sessions(h).length, 1);
    assert.deepEqual(heard(h, session), [openingText(), 'Also fix Firefox']);
  });
}
