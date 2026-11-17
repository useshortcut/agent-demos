# Cloudflare runtime smoke tests

From any demo directory, run:

```sh
npm ci
npm test
npm run test:runtime
npx wrangler deploy --dry-run
```

The runtime suite is separate from the fast Node regression tests. It bundles the
real entrypoint and runs it in local `workerd` through Miniflare, using the demo's
Wrangler compatibility date/flags, KV bindings, and Durable Object classes and
SQLite migrations. A test-only entrypoint additionally awaits work registered
with `waitUntil`, so asynchronous effects finish before assertions run.
For Team Cop, the test entrypoint subclasses its real coordinator only to expose
a fixed read-only SQL completion query to the harness; its constructor, database,
delivery logic, and alarm handler are unchanged. No test route is shipped in the
deployment bundle.

All credentials and OAuth codes are synthetic. No Cloudflare login, API token,
Shortcut workspace, `.dev.vars`, or account namespace is needed. KV and SQLite
state are isolated to the test instance and disposed afterward. Every outgoing
Worker request is routed to an in-process mock Worker that rejects unknown
origins, paths, methods, fields, and pagination parameters instead of forwarding
to the internet. For a bridge the same mock also answers the backend's API
through the bridge's vendor mock, with synthetic credentials. Installing
dependencies requires access to npm; test requests do not contact Shortcut or
Cloudflare accounts.

Coverage includes:

- Every demo: native OAuth fetch and credential storage, signed validation
  acceptance, and invalid-signature rejection. The three comment-posting demos
  also cover API field selection and opaque cursors.
- Estimate Guardian: a zero-point Estimate is accepted; an unset Estimate causes a
  comment before state revert, then an existing warning suppressing a
  second comment and revert while the Story still appears started.
- Quote Agent: concurrent duplicate delivery, receipt persistence through actual
  object eviction, distinct interactions, and Story/Epic threaded replies.
- Devin Bridge: OAuth enabling the agent-session subscription, a signed
  `session.created` answered on turn 1 through real Durable Object alarms
  (ack, Devin session, "Open in Devin" link, response), a redelivered event
  creating no second Devin session, and a `session.prompted` follow-up relayed
  into the same Devin session and answered on turn 2. Its polling deadline is
  20 seconds instead of 10 because the bridge's first Devin poll is 5 seconds
  out.
- OpenAI Bridge: the same two-turn scenario against an Agents API mock that
  requires the `OpenAI-Beta: agents=v1` header and an `Idempotency-Key` on
  each message, and answers each input at once with a completed turn. The
  card gets no link, so `links` is empty.
- Team Cop: actual SQLite storage and scheduled alarm processing, completion
  receipts across object eviction, and a new Story event finding an existing
  comment rather than posting another reminder.

Polling is bounded and waits for durable completion, not just an observed POST.
The full test also has a deadline and disposes the runtime on failure. The mock
enforces the narrow API contract used by these scenarios; it is not a replacement
for integration testing against Shortcut's deployed API.

`esbuild`, `miniflare`, and `wrangler` are explicit dev dependencies of each demo.
Miniflare is pinned to the version bundled with the current Wrangler release
because the harness uses its local-runtime and storage-inspection APIs. When
upgrading Wrangler/Miniflare, run every runtime suite. CI runs these suites
and `wrangler deploy --dry-run`; it never uploads a Worker or provisions account
resources.

## Bridges

A demo with a `test/smoke.mjs` descriptor runs the bridge scenario. Shortcut
sends `session.created` for Story 123 in workspace `acme` with the prompt
"Please fix the login bug", sends it again, then sends `session.prompted` with
"Also fix Firefox" on turn 2. The descriptor exports:

- `bindings`: the Worker's bindings beyond the OAuth and webhook secrets and
  `SHORTCUT_API_BASE`, such as the backend's API base and
  `ALLOWED_WORKSPACE_IDS: 'workspace'`.
- `eventuallyMs`: how long to poll for each turn's response.
- `ack`: the idempotency key of the first activity.
- `links`: the session's `external_urls` after turn 1.
- `responses`: one pattern per turn that its response body must match.

The smoke prepends the bridge's `test/smoke-vendor.js` to `upstream.mjs`, so
the mock runs inside workerd and the file has no imports or exports. It
declares `const vendor` with:

- `origin`: requests to it go to `handle` and are recorded with the Shortcut
  requests.
- `handle(request, url, reject)`: answers one request. A request outside the
  backend's contract returns `reject(request, detail)`, which fails the test.
- `results()`: `{ sessions, received }`, the backend sessions the bridge
  created and the follow-up messages it sent. The scenario expects one session
  and `['Also fix Firefox']`.
  A backend whose session opens empty, such as Claude Bridge's, takes the
  opening request as the session's first message. Its mock counts that one
  as the opening, not as received.

A bridge's Node regression tests use `bridge/harness.mjs`.
`bridgeHarness({ root, secrets, sensitive, vendor })` bundles `src/index.ts`
with the demo's own esbuild and returns `{ mod, SECRETS, setup }`. `SECRETS`
adds the backend's `secrets` to the Shortcut ones, and `sensitive` is the
pattern no log may match. `setup(t)` gives each test fake Durable Object storage
and alarms, a Shortcut mock, a mocked clock, and captured requests and logs.
`vendor` is `{ origin, env, mock(log) }`: the mock answers with
`handle(url, init)` and returns its one session from `only()`.

### The fake backend

`bridge/core.test.mjs` tests the paths of `src/core` that a bridge's own backend
may never take: a stop that keeps the session, a session opened empty and
introduced by its first message, a `session.created` that arrives during that
introduction, a session with no link, a send repeated under its key after a
crash, and a hold. It runs in every bridge's `npm test`, against the `src/core`
of the bridge in the current directory, and makes no backend request.

For it, `bridgeHarness` takes a fifth option. `backend` is the URL of a module
to bundle in place of the bridge's `src/backend.ts`. The bundle then also
exports that module as `backend`, and the core's `BackendError` for a test to
throw.

`bridge/fake-backend.ts` is that module. It sits outside every demo and is
bundled into whichever bridge runs the test, so it imports only types.
`devin-bridge`'s `npx tsc --noEmit` checks it against the port. Its
`script(log)` returns what a test drives, and the fake reads it from the
`FAKE` binding:

- `facts`: what kind of backend this is. `linked` gives each chat a URL,
  `keeps` makes a halt answer `kept`, `empty` makes an open create a chat
  with no message that a later open cannot find again, and `dedupes`, which
  is on unless a test turns it off, makes a send repeated under its key
  deliver nothing new. A test sets one before the call it bears on.
- `chats`: the conversations opened, oldest first, and `only()` for the one.
  A chat holds `opened` (the text the open carried, or null), `received` (the
  messages delivered), `sends` (every send, repeats included), and `halted`. A test sets its `status` to what the next `observe`
  reports, and `gone` to make `prepare` answer `gone`. `prepare` answers
  `empty` from the chat itself: nothing in `opened` and nothing in `received`.
- `say(chat, text)`: the agent says something.
- `failNext(call, error, { landed })`: the next `open`, `prepare`, `send`,
  `observe`, or `halt` throws `error`. With `landed` it does its work first,
  like a request whose answer was lost.
- `misuse`: what the bridge did that no backend should see, such as one send
  key on two different sends. Each test in `core.test.mjs` expects it empty.

### The ledger and the exhaustive run

`bridge/ledger.mjs` states what a bridge owes the agent, whatever order
Shortcut's events arrive in and whichever backend calls fail. Its `RULES` are
the specification, written once and in plain words, and each bridge's README
has to agree with them. The file shares nothing with `src/core`. It is told
which events arrived, what each backend call carried, what landed at the
backend, and whether the bridge learned of it, and it names each rule the
bridge broke.

`bridge/exhaust.mjs` runs scripts through the real webhook and alarm loop
against the fake backend and reports every step to the ledger. A script is a
list of steps such as `'reply 2'`, `'stop 1'`, `'tick'`, `'tick: send lost'`,
`'gone'`, and `'rest'`. The head of the file lists them all. Shortcut holds
every event from the start and delivers each when the script says, so an
event can arrive in any order. Shortcut's own turn follows what it has
delivered, until `'ahead 2'` moves it to the turn of a reply it has not
delivered yet. That is a user who replies before the bridge has acknowledged
the turn before, and Shortcut then answers a write for the older turn with a
409. A fault makes one backend call of a step fail before it reaches
the backend (`fails`), fail after the backend took it (`lost`), answer and
then have the step die before its save (`dies`), or be refused by the backend
with a 401 (`refused`). An event can also arrive while one backend call of a
step is out, as in `'tick: stop 2 during prepare'`. Shortcut then has the
bridge's answer before the backend's answer reaches the step, so the bridge
owes the event to the step's next call. `'rest'` delivers the reply Shortcut
is ahead by, lets every agent finish, and runs the alarms out. Only then does
the ledger ask what is still owed.

`bridge/exhaust.test.mjs` runs in every bridge's `npm test`. `explore` runs
every script of a scope, shortest first, on each of the eight kinds of backend
the port allows: one that keeps or ends its conversation on a stop, opens it
empty or with the request, and deduplicates a repeated send or repeats it.
Devin is the kind that ends, opens with the request, and repeats. The default
scope is every script that holds at most four of these together: the events
`created`, `reply 2`, `reply 3`, `stop 1`, `stop 2`, and `close`, one fault,
one agent that finishes, and one conversation that ends on its own. The fault
is a backend fault or Shortcut a reply ahead.
Either stop may arrive while a backend call is out.
The backend refuses only a `prepare` or a `send`, the two calls of a relay.
Alarms are free. After every alarm the search also lets the bridge come to
rest, and wherever nothing is scheduled it delivers the last event a second
time and expects nothing to change. The test prints how many scripts it
covered.

The search does not run each script from the start. Two scripts that reach
the same stored state, backend, Shortcut session, and ledger have the same
future, so the second one ends there. Of the clock, that comparison keeps
only what decides which jobs the next alarms run. A second test keeps the
merging honest: it runs every script of a small scope from its own start,
with nothing merged, and expects the search to count the same scripts. With
one fault to a script, a backend that deduplicates sends differs from its
twin only when the fault is a send that landed, so it runs only those
faults.

A bridge that never comes to rest would keep the search from ending. So a
step that makes more than 30 backend calls is ended, and a script that still
finds a new state after 40 steps is not followed further. Both break `loop`.

When a script breaks a rule the test fails with the rule, what happened, the
backend, and the shortest script that does it, as a line to paste into
`PINNED` in the same file. A pinned script runs on its own in every
`npm test`, and `replay(w, steps)` runs one from any test. The pinned scripts
are defects found so far: by the search, by wider runs of it, and by review.

`OPEN` in the same file lists the scripts that still break a rule. Each holds
a backend fault and also puts Shortcut ahead, which is two faults, so the
default scope does not reach them. They run as todo tests: the report shows
them and `npm test` passes.

`EXHAUST=deep` widens the scope: `reply 4` and `stop 3` join the events, any
of the three stops may arrive while a call is out, the backend may refuse any
call, a script holds up to five events and two faults, and up to six of
everything together. It never puts Shortcut ahead, because the scripts under
`OPEN` would fail it. Before a stop could arrive during a call, the deep scope
was about 207 million scripts through 13 million states, and on an 18-core
machine it took ten minutes and 41 GB of memory. It has not been measured
since. It is run by hand before a change to the core is merged.
`EXHAUST_SCOPE` takes a JSON object that replaces fields of the scope, for a
run in between.

The search cannot reach what its scripts cannot say. Shortcut refuses a write
only for a turn it has moved past, and never fails. Only a stop arrives
while a call is out. The ledger takes a send's text as fixed when the send
goes out, so it cannot place a reply or a `session.created` that arrives
between a prepare and its send. It takes every refused `observe` to end
the turn, also the read before a send that carries only the context, which
ends none. No backend call is held
by a `Retry-After`. A refusal is a 401, apart from the 410 of a send to a
conversation that ended on its own. No wait runs out: not the pickup timeout, the failure budget, or
the heartbeat. The agent never asks a question. `session.created` always has a
request and a context. The backend is the fake one, so an adapter's own calls
are covered only by its own suite and by `conform`.

`bridge/broken-cores.test.mjs` keeps the search honest. It copies the bridge's
`src`, breaks one behavior in the copy, and expects the search to break the
rule that owns it: a core that drops every send it prepared, one that forgets
the stop a cancelled request arrives after, one that takes the context as told
before the send that carries it is confirmed, one that introduces a
conversation twice, one that introduces an empty conversation with nothing to
be asked, one that ends the turn when the backend refuses a send that
carried only the context, one that reads its inbox only when a step starts,
one that gives up an open when Shortcut answers its acknowledgement with
a 409, and one that sends the context alone without reading the agent first. When you add a rule, add the core that breaks it.

### Conformance

`bridge/conform.mjs` exports `conform`, the scenarios every bridge owes
Shortcut whatever its backend: open, progress, finished, a reply to the same
session, asked and answered, an approval awaited and given, failed, stop then
reply, close, an open and a send whose answers are lost, and a redelivered
event. A bridge calls it from
one test file with its own harness, so each adapter is held to the same list.
`devin-bridge/test/conform.test.mjs` is the example. `conform` takes:

- `setup`: the bridge's `setup(t)`.
- `identity`: the `slug`, `name`, `aSession`, and `linkLabel` the bridge's
  activities should carry, written out, not imported.
- `facts`: the five things on which backends differ. Each is declared `true`
  or `false`, and `conform` fails one that is left out. `keeps` says a stop
  leaves the session open, so the next reply goes to it. `opensEmpty` says the
  session is created with no message and the opening text is its first.
  `linked` says a session has a URL for the card and the outcomes. `dedupes`
  says the backend takes the send key, so a send repeated after a lost answer
  is delivered once. Without it the repeat may be delivered, so the scenario
  allows one or two deliveries and no more. `approves` says the agent can wait
  for an approval that is given in the backend's own app, which the adapter
  reports as `asked` on `approval`. Without it the approval scenario is
  skipped, and the test report says so.
- `vendor`: what the test can do to the vendor mock. `sessions(h)` lists the
  sessions the bridge opened, oldest first. `told(h, session)` returns
  `{ opened, messages }`: the text the create carried, or null, and the texts
  sent after it. A reply that goes back as a tool result counts as a message.
  `url(session)` is read only when `linked`. `work`, `finish`, and `fail` take
  `(h, session)` and set what the vendor reports, `say(h, session, text)` adds
  an agent message, and `ask(h, session, question)` makes the agent ask the
  user and wait. `awaitApproval(h, session, question)` makes the agent say
  `question` and wait for an approval in the backend's own app. It is called
  only when `approves`, and the agent's later `work`, `say`, and `finish`
  stand for the approval being given. `fail` is a failure that ends the turn. `halted(h, session)`
  says whether the vendor was told to stop the session, and
  `takes(h, session)` whether the mock would still accept a message for it.
  The stop scenario holds `takes` against `facts.keeps`, so the fact is
  checked against the mock and not only declared. `lose(h, call)` makes the
  next `'open'` or `'send'` do its work at the vendor and then fail, like a
  request whose answer was lost.
- `label`: optional, names the tests when one suite calls `conform` twice.

`core.test.mjs` also runs `conform` against the fake as the two kinds of
backend no bridge has yet: one that keeps its session, opens it empty, and has
no link, and one that keeps its session and opens it with the request.
`bridge/fake-conform.mjs` holds the fake's side of those arguments.

`bridge/mutants.test.mjs` tests the scenarios themselves. `bridge/mutant.mjs`
is the fake backend with one wrong behavior, named by the `MUTANT` variable:
an `open` or a `send` that ignores its key, an `open` that answers
`delivered` for a session it opened empty, a `prepare` that never reports a
session empty or reports every session empty, an `observe` that ignores the
prepared memo, returns only the first of several messages, reports a
question for the user as an approval, or reports an approval as a question
for the user, and a `halt` that answers `ended` while the session still takes
messages or `kept` after it ended the session. The test runs `conform` against
each in a child process and expects the scenario that owns the behavior to
fail. A wrong behavior shows only on some kinds of backend, so the `FACTS`
variable sets the kind for each: an `open` that answers `delivered` and a
`prepare` that never reports empty are wrong only for a backend that opens
its session empty. When you add a scenario for something an adapter could get
wrong, add its mutant, on a kind of backend where the scenario fails it.

`harness.mjs` exports `REQUEST` and `CONTEXT`, the prompt and the context of
the mock's `session.created`, and `openingText(asked, context)`, the text a
backend should be told for them.
