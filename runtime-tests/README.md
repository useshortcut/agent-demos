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
upgrading Wrangler/Miniflare, run all four runtime suites. CI runs these suites
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

A bridge's Node regression tests use `bridge/harness.mjs`.
`bridgeHarness({ root, secrets, sensitive, vendor })` bundles `src/index.ts`
with the demo's own esbuild and returns `{ mod, SECRETS, setup }`. `SECRETS`
adds the backend's `secrets` to the Shortcut ones, and `sensitive` is the
pattern no log may match. `setup(t)` gives each test fake Durable Object storage
and alarms, a Shortcut mock, a mocked clock, and captured requests and logs.
`vendor` is `{ origin, env, mock(log) }`: the mock answers with
`handle(url, init)` and returns its one session from `only()`.
