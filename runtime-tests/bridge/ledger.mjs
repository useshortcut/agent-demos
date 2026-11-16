// What a bridge owes the agent, whatever order Shortcut's events arrive in
// and whichever backend calls fail. The rules are stated here and nowhere
// else. This file shares nothing with src/core: it is told which events
// arrived, what each backend call carried, and what Shortcut accepted, and it
// names every rule the bridge broke. exhaust.mjs feeds it.
//
// A request is what the user asked for: the text of `session.created`, on
// turn 1, or of a reply. The context is what Shortcut says about the story,
// and it arrives with `session.created`. A text is what one open or one send
// carries. It is fixed when the open is first tried, or when the send is
// prepared. It lands when the backend takes it. The bridge learns of a
// landing when the call answers and the step saves its state. A send repeated
// under its key, or an open that finds the conversation again, teaches it
// later. Until then the landing is one the bridge cannot know about. A
// prepare that finds a message in a conversation teaches it less. It shows
// that the conversation's first text landed, and so whether that text told
// the conversation the context. A turn has its outcome once the bridge has read that the
// agent finished or failed, once a backend call was refused, or once Shortcut
// holds a response, a question, or an error for it.
export const RULES = {
  stopped: 'A stop cancels every request at or below its turn, also one that arrives later. Once the stop has arrived, no call carries a cancelled request.',
  superseded: [
    'A request the agent has moved past is superseded, and no text fixed after that carries it.',
    'A reply is superseded when it arrives after the bridge learned that a newer reply landed.',
    'A reply that arrives while a newer reply waits in a prepared send is superseded when the bridge learns that the send landed.',
    'A reply that arrives while a newer reply waits in an open that has no answer yet is not superseded. It follows the open.',
    'The request of a `session.created` is accepted when it arrives before any text is fixed, or while the bridge is still on its first conversation, has received no reply newer than the one it started from, and no turn has an outcome. Otherwise it is superseded. Once accepted it is never superseded.',
  ].join(' '),
  once: 'No text carries a request twice, and no request lands twice, unless the bridge never learned that its earlier landing happened. Then it may land once more, as that send\'s retry or in the text that takes its place after a stop halted the conversation.',
  ordered: 'A text carries its requests in turn order.',
  briefed: 'A text that is fixed after `session.created` arrived carries the context when it lands in a conversation that no earlier text told it to. A stop cancels requests and never the context.',
  briefedOnce: 'No text carries the context twice, and no conversation is told it twice, unless the bridge never learned that the earlier text landed. A conversation\'s first text is never such an exception once a prepare has found a message in it.',
  owed: 'Every open carries a request that is still owed, which is one that arrived, is neither cancelled nor superseded, and has not landed as far as the bridge knows. Every send carries one too, or the context alone. The context goes alone only while the bridge is still on its first conversation, has received no reply newer than the one it started from, and no turn has an outcome.',
  rest: 'When the bridge comes to rest, every request that arrived has landed, or is cancelled or superseded, or its turn or a later one ended in an error the user was told about.',
  keys: 'A send is prepared before it first goes out. A retried open or send repeats its text, and no two different sends share a key.',
  single: 'When the bridge comes to rest, at most one conversation is working.',
  links: 'A conversation without a URL gets no card link, and no activity carries link text for it.',
  loop: 'Every step ends without an error of its own, and once no event is waiting and no agent is working the alarms run out.',
};

const count = (text, part) => text.split(part).length - 1;

/** `tokens.request` and `tokens.context` are the texts of `session.created`, and `tokens.reply(turn)` the text of a reply. `opensEmpty` says an open delivers no text. */
export function ledger(tokens, { opensEmpty }) {
  const fresh = () => ({
    created: false,
    closed: false,
    cutoff: 0,
    first: null,
    newest: 0,
    outcome: false,
    failedTurn: 0,
    laterOpen: false,
    fixedAny: false,
    learnedNewest: 0,
    requests: {},
    texts: {},
    told: {},
    preparing: null,
  });
  let s = fresh();
  let problems = [];
  const broke = (rule, what) => problems.push(`${rule}: ${what}`);

  const tokenOf = (turn) => (turn === 1 ? tokens.request : tokens.reply(turn));
  const named = (turn) => (turn === 1 ? 'the opening request' : `reply ${turn}`);
  const carried = (text) => Object.keys(s.requests).map(Number).filter((turn) => text.includes(tokenOf(turn))).sort((a, b) => a - b);
  const cancelled = (turn) => turn <= s.cutoff;
  const stillOwed = (turn) => !cancelled(turn) && !s.requests[turn].superseded && !(s.requests[turn].landed && s.requests[turn].learned);
  const onOpening = () => !s.laterOpen && s.newest === s.first && !s.outcome;

  function fix(id, text, { conversation, knew, alone, send }) {
    const holds = carried(text);
    // A newly prepared send means the bridge gave up the one before it, so nothing waits on that one any more.
    if (send) for (const earlier of Object.values(s.texts)) if (earlier.send) earlier.dropped = true;
    s.texts[id] = { conversation, text, holds, knew, send, landed: false };
    if (send || !opensEmpty) s.fixedAny = true;
    for (const turn of holds) {
      if (count(text, tokenOf(turn)) > 1) broke('once', `one text carries ${named(turn)} twice`);
      if (s.requests[turn].superseded) broke('superseded', `a text fixed after ${named(turn)} was superseded carries it`);
    }
    const places = holds.map((turn) => text.indexOf(tokenOf(turn)));
    if (places.some((at, i) => i > 0 && at < places[i - 1])) broke('ordered', `a text carries ${holds.map(named).join(', ')} out of turn order`);
    if (count(text, tokens.context) > 1) broke('briefedOnce', 'one text carries the context twice');
    if (holds.some(stillOwed)) return;
    if (!send) broke('owed', 'an open carries no request that is still owed');
    else if (!text.includes(tokens.context)) broke('owed', 'a send carries neither a request that is still owed nor the context');
    else if (!alone) broke('owed', 'a send carries the context alone though the bridge had moved past the turn it started from');
  }

  function call(id, text) {
    for (const turn of s.texts[id].holds) if (cancelled(turn)) broke('stopped', `a call carries ${named(turn)} after the stop of turn ${s.cutoff} arrived`);
    if (s.texts[id].text !== text) broke('keys', `a retried ${s.texts[id].send ? 'send' : 'open'} changed its text`);
  }

  function land(id, conversation) {
    const text = s.texts[id];
    Object.assign(text, { conversation, landed: true });
    for (const turn of text.holds) {
      const request = s.requests[turn];
      if (request.landed && request.learned) broke('once', `${named(turn)} landed twice`);
      Object.assign(request, { landed: request.landed + 1, learned: false, last: id });
    }
    const told = (s.told[conversation] ??= { context: 0, learned: true, last: null, first: id });
    if (text.text.includes(tokens.context)) {
      if (told.context && told.learned) broke('briefedOnce', `${conversation} was told the context twice`);
      Object.assign(told, { context: told.context + 1, learned: false, last: id });
    } else if (text.knew && told.context === 0) {
      broke('briefed', `${conversation} was told ${JSON.stringify(text.text.slice(0, 60))} without the context, which had arrived before that text was fixed`);
    }
  }

  function learn(id) {
    const text = s.texts[id];
    if (!text?.landed) return;
    for (const turn of text.holds) if (s.requests[turn].last === id) Object.assign(s.requests[turn], { learned: true, last: null });
    s.learnedNewest = Math.max(s.learnedNewest, ...text.holds);
    const told = s.told[text.conversation];
    if (told.last === id) Object.assign(told, { learned: true, last: null });
    for (const request of Object.values(s.requests)) if (request.waits === id) Object.assign(request, { waits: null, superseded: !request.landed });
    // Nothing more can happen to a text the bridge knows has landed.
    delete s.texts[id];
  }

  return {
    get state() { return s; },
    set state(next) { s = next; },
    /** The rules broken since the last call, each as `rule: what happened`. */
    broken() {
      const found = problems;
      problems = [];
      return found;
    },

    arrived({ type, turn }) {
      if (type === 'close') return void (s.closed = true);
      s.first ??= turn;
      if (type === 'stop') return void (s.cutoff = Math.max(s.cutoff, turn));
      const request = (s.requests[turn] = { superseded: false, waits: null, landed: 0, learned: true, last: null });
      if (type === 'created') {
        s.created = true;
        request.superseded = !cancelled(turn) && s.fixedAny && !onOpening();
        return;
      }
      s.newest = Math.max(s.newest, turn);
      if (cancelled(turn)) return;
      if (s.learnedNewest > turn) request.superseded = true;
      else request.waits = Object.keys(s.texts).find((id) => s.texts[id].send && !s.texts[id].dropped && s.texts[id].holds.some((held) => held > turn)) ?? null;
    },

    /** Shortcut accepted an activity. */
    posted({ type, turn }) {
      if (type === 'response' || type === 'elicitation' || type === 'error') s.outcome = true;
      if (type === 'error') s.failedTurn = Math.max(s.failedTurn, turn);
    },
    /** The bridge read the end of a turn from the backend, or a call was refused. */
    ended() {
      s.outcome = true;
    },

    opening(key, text) {
      if (Number(key.match(/-(\d+)$/)?.[1]) > 1) s.laterOpen = true;
      if (!s.texts[key]) fix(key, text, { conversation: null, knew: s.created, alone: false, send: false });
      // Nothing reads the text of an open that delivers none, so it may differ between attempts.
      call(key, opensEmpty ? s.texts[key].text : text);
    },
    /** `landed`: this call created the conversation with its text. `learned`: the call answered and the step saved. */
    opened(key, { conversation, landed, learned }) {
      if (landed) land(key, conversation);
      if (learned) learn(key);
    },

    /** `ready`: the conversation takes a message. `empty`: it holds none. */
    prepared(conversation, { ready, empty }) {
      const told = s.told[conversation];
      if (!empty && told && told.last === told.first) told.learned = true;
      s.preparing = ready ? { conversation, knew: s.created, alone: onOpening() } : null;
    },

    sending(conversation, key, text) {
      if (!s.texts[key]) {
        if (s.preparing?.conversation !== conversation) broke('keys', 'a send went out under a new key without a prepare');
        fix(key, text, { conversation, knew: s.preparing?.knew ?? s.created, alone: s.preparing?.alone ?? false, send: true });
      } else if (s.preparing) {
        broke('keys', 'a newly prepared send reuses a key');
      } else if (s.texts[key].conversation !== conversation) {
        broke('keys', 'one send key went to two conversations');
      }
      s.preparing = null;
      call(key, text);
    },
    sent(key, { landed, learned }) {
      if (landed) land(key, s.texts[key].conversation);
      if (learned) learn(key);
    },

    /** What the caller saw itself: a step that threw, a key the backend saw misused. */
    saw(rule, what) {
      broke(rule, what);
    },

    /** The bridge has nothing scheduled. `working` counts the conversations that hold a message and were neither halted nor ended. `links` counts the card links and link texts written for a backend whose conversations have no URL. */
    rested({ working, links }) {
      if (links) broke('links', `${links} link${links === 1 ? ' was' : 's were'} written for a backend without URLs`);
      if (s.closed) return;
      for (const [turn, request] of Object.entries(s.requests)) {
        if (request.landed || cancelled(Number(turn)) || request.superseded || Number(turn) <= s.failedTurn) continue;
        broke('rest', `${named(Number(turn))} never reached the agent`);
      }
      if (working > 1) broke('single', `${working} conversations are left working`);
    },
  };
}
