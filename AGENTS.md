# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## What this repo is

Reference implementations for Shortcut Custom Agents — web services that receive signed webhooks from a Shortcut workspace and call back into the Shortcut v4 API. Each demo lives in its own top-level directory with its own `package.json` and README, and is meant to be small, readable end to end, and focused on one idea (per the root README's contributing note — not production-ready).

- `estimate-guardian/` — observer-only agent: blocks stories from being started without an Estimate (comments at the mover, reverts the state).
- `quote-agent/` — interaction-triggered agent: posts a random quote when assigned, @-mentioned, or replied to. Shows the full lifecycle including threaded replies.
- `docs/custom-agents.md` — the platform reference: payload shapes (observer vs. interaction envelopes), trigger semantics, review lifecycle. Read this before touching webhook-handling code.
- `team-cop/` — observer agent that comments when stories are created or started without a Team. Uses a SQLite Durable Object for credentials, receipts, and capped alarm retries. Plain JavaScript, no Hono or KV; run `npm test`, `npm run dev`, and `npm run deploy:check` from its directory. The Hono/KV conventions below apply to the other two demos.

## Commands

Run everything from inside the demo directory you're working on (`estimate-guardian/` or `quote-agent/`):

```bash
npm install
npm run dev          # wrangler dev --local, serves http://localhost:8787
npm run deploy       # wrangler deploy
npm test             # regression tests with mock Shortcut responses
npx tsc --noEmit     # strict type check
```

Local dev needs `.dev.vars` (copy from `.dev.vars.example`). Webhook signatures are always required, including locally; there is no bypass flag. `SHORTCUT_API_BASE` overrides the API host for local testing and should not be set in production.

Deployment also requires a KV namespace (`npx wrangler kv namespace create TOKENS`, ids go in `wrangler.toml`) and secrets pushed via `npx wrangler secret put` (CLIENT_ID, CLIENT_SECRET, WEBHOOK_SECRET, REDIRECT_URI). See each demo's README for the full sequence.
Quote Agent additionally declares a SQLite Durable Object for serialized interaction delivery receipts; deploy its updated Wrangler configuration along with its code. Existing OAuth credentials remain in `TOKENS`.
Estimate Guardian also declares a SQLite Durable Object per workspace/Story for warning/revert progress and bounded recovery alarms. Deploy its `ESTIMATE_GUARDIAN_STORIES` binding and `v1` migration with the code; OAuth credentials stay in `TOKENS`.

## Architecture

Estimate Guardian reads `estimate,workflow_state`, treats zero as estimated, and reacts to workflow-state or estimate updates (not Team-only changes). Team Cop independently handles Team membership reminders without changing workflow state.

Both demos are Cloudflare Workers with Hono entrypoints (`src/index.ts`), and share the same OAuth/KV skeleton:

- **Endpoints**: `GET /oauth/callback` (token exchange), `POST /webhook` (delivery receiver), `GET /` (health only; it is unauthenticated, so it never lists connected workspaces). Both handlers return 503 until all four secrets are set, and the webhook caps bodies at 2 MB.
- **Storage**: one KV namespace bound as `TOKENS`. Credentials are stored per workspace at `creds:{workspace_id}` as `{token, slug, refreshToken, expiresAt, memberId, scopes?, capabilities?}`. `memberId` is the agent's own `permission_id` from the OAuth token response; `scopes` is absent for records saved before scopes were reported, and `capabilities` (`{assignable, mentionable}`, Quote Agent only) is absent for records saved before it was reported. Absent means unknown, never off.
- **Shortcut client**: all three demos use `@shortcut/client` (3.4.0+). `ShortcutV4Client` from `@shortcut/client/v4` makes the API calls (`client.workspace(slug)` binds the slug; a failed request rejects with the `Response`, narrowed by `isShortcutV4RequestError`), `ShortcutOAuth` does the code exchange and refresh, and `ShortcutWebhookClient.verifyBody` from `@shortcut/client/webhooks` verifies the signature and validates the delivery envelope. Pass `timeoutMs: 15_000` to `ShortcutV4Client` and `ShortcutOAuth`; the library aborts each request, including refresh waits, retries, and reading its body, with a `TimeoutError`, reads every body exactly once, and URL-encodes path parameters, so hand it raw ids. Pass `refresh: { expiresAt, run }` to `ShortcutV4Client` and it rotates the token itself (before a request within five minutes of expiry and once more on a 401, then retries); `run` refreshes with `ShortcutOAuth`, persists, and returns the new token. A rejected request's `error` is the parsed body, the raw text of a non-JSON body, or `null`, and its `request` names the method and pathname; log `summarizeShortcutV4Error(error)` and nothing else from it.
- **Auth**: OAuth authorization-code flow against `/oauth-authorization-code-flow/token`, via `ShortcutOAuth`. The demos own credential storage and the `refresh.run` callback; the client owns when to refresh and the retry.
- **Webhook verification**: HMAC-SHA256 over the raw request body, hex digest in the `Payload-Signature` header. The demos read the body with their own size cap (413 before verifying) and hand the bytes to `verifyBody`, which rejects bad signatures (401) and payloads missing the delivery envelope (400). Validation pings `{ "type": "validation" }` pass through it.
- **API base**: `https://api.app.shortcut.com/api/v4/{workspace_slug}/...`, overridable with `SHORTCUT_API_BASE`. Lists are cursor-paged: `client.paginate(list)` follows `next_page_url`, sends only `cursor` and `fields` on later pages, and fails closed on unsafe links, repeated cursors, and missing pages. The default page size is 10; the demos ask for 100 on the first page.

### Invariants that matter when editing

- **Only story update actions carry a diff.** `changes` (same `attribute`/`adds`/`removes` shape as v4 history entries) is on story `update` actions only. An absent key means *unavailable* (degraded delivery or uncovered entity type), never *unchanged*; `[]` means nothing tracked changed. Estimate Guardian filters on it before any API call (`couldBreachRule`) and reads the previous workflow state from it, falling back to `GET /stories/{id}/history` when absent. From either source, `removes` is only trustworthy when `adds[0].id` matches the entity's current value — otherwise it describes an older change. Current state always comes from re-reading the entity.
- **`uri` on actions is deprecated.** Read `app_url`; `uri` is frozen and not present for newer entity types.
- **Address people from the delivery.** `actor.mention_name` carries the acting member's @-handle when they have one; fall back to a sanitized `displayable_name` and never fetch the member for it.
- **Agents see their own writes.** Every write comes back as a fresh observer delivery. Two defenses, both required: drop deliveries where `actor.member_id` equals the stored `memberId`, and check for the durable effect of a past run (estimate-guardian scans for its own warning comment via `WARNING_MARKER`) so retries/restarts can't double-write.
- **`fields` query params are load-bearing.** Every v4 endpoint takes `fields`; unrequested fields are never calculated, and unknown field names are a 400 (not ignored). In estimate-guardian, each `*_FIELDS` constant sits directly above the TypeScript type it fills — change one, change the other. Writes request `fields=id` only.
- **Estimate Guardian's ordering: comment before revert.** If the comment fails, the revert is skipped. The per-Story coordinator persists the operation and alarm before posting, then records confirmed warning versus completed revert. Alarms retry only that operation (initial attempt plus five retries, within five minutes), re-reading the current Story immediately before each PATCH. Ordinary old warnings never authorize recovery. Webhooks await the coordinator so recovery is durable before acknowledgment; no `waitUntil`-only recovery.
- **Don't cache failure.** Estimate Guardian caches started-state ids in KV for an hour, but never caches an empty lookup result — that would silently disable the agent.
- **Don't use partial lists.** `client.paginate` fails closed on HTTP failures, malformed pages, unsafe continuation URLs, and loops; callers must let that rejection propagate. An incomplete comment scan must never mean "not already posted."
- **Never log library errors whole.** A rejected v4 request is a `Response` whose `error` body can echo request content; log `summarizeShortcutV4Error(error)` (method, pathname, status, identifier-shaped `tag`/`error` codes) and, for `ShortcutOAuthError`, the status and identifier-shaped `error` code. Never log free-form messages.
- **Quote Agent deduplicates interactions, not stories.** Repeated delivery of the same interaction must not post twice; a genuinely new mention, assignment, or reply should still get a quote. Serialize receipt checks and writes and use the remote comment marker to recover interrupted posts.
- **Safe diagnostics.** Bound outgoing request durations and log only the library's failure summary, so credentials, OAuth code/state, cursor values, and request content never reach a log. Persist granted OAuth scopes without treating an older credential record's missing scope as a known grant, and the same for `capabilities`: Quote Agent warns when a reported capability is off, never when it is unreported.
