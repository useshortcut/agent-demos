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
- **Storage**: one KV namespace bound as `TOKENS`. Credentials are stored per workspace at `creds:{workspace_id}` as `{token, slug, refreshToken, expiresAt, memberId}`. `memberId` is the agent's own `permission_id` from the OAuth token response.
- **Auth**: OAuth authorization-code flow against `/oauth-authorization-code-flow/token`. Tokens are refreshed proactively when within 5 minutes of expiry and reactively on a 401 (see `apiFetch` in estimate-guardian).
- **Webhook verification**: HMAC-SHA256 over the raw request body, hex digest in the `Payload-Signature` header. Always verify before parsing/acting.
- **API base**: `https://api.app.shortcut.com/api/v4/{workspace_slug}/...`. List responses include `entities`, `current_page`, and `total_pages`, but requests use cursor pagination, not a `page` parameter. Follow `next_page_url`; cursor requests may include only `cursor` and optional `fields` (no `limit`). The default page size is 10.

### Invariants that matter when editing

- **Only story update actions carry a diff.** `changes` (same `attribute`/`adds`/`removes` shape as v4 history entries) is on story `update` actions only. An absent key means *unavailable* (degraded delivery or uncovered entity type), never *unchanged*; `[]` means nothing tracked changed. Estimate Guardian filters on it before any API call (`couldBreachRule`) and reads the previous workflow state from it, falling back to `GET /stories/{id}/history` when absent. From either source, `removes` is only trustworthy when `adds[0].id` matches the entity's current value — otherwise it describes an older change. Current state always comes from re-reading the entity.
- **`uri` on actions is deprecated.** Read `app_url`; `uri` is frozen and not present for newer entity types.
- **Agents see their own writes.** Every write comes back as a fresh observer delivery. Two defenses, both required: drop deliveries where `actor.member_id` equals the stored `memberId`, and check for the durable effect of a past run (estimate-guardian scans for its own warning comment via `WARNING_MARKER`) so retries/restarts can't double-write.
- **`fields` query params are load-bearing.** Every v4 endpoint takes `fields`; unrequested fields are never calculated, and unknown field names are a 400 (not ignored). In estimate-guardian, each `*_FIELDS` constant sits directly above the TypeScript type it fills — change one, change the other. Writes request `fields=id` only.
- **Estimate Guardian's ordering: comment before revert.** If the comment fails, the revert is skipped. The per-Story coordinator persists the operation and alarm before posting, then records confirmed warning versus completed revert. Alarms retry only that operation (initial attempt plus five retries, within five minutes), re-reading the current Story immediately before each PATCH. Ordinary old warnings never authorize recovery. Webhooks await the coordinator so recovery is durable before acknowledgment; no `waitUntil`-only recovery.
- **Don't cache failure.** Estimate Guardian caches started-state ids in KV for an hour, but never caches an empty lookup result — that would silently disable the agent.
- **Don't use partial lists.** Cursor traversal must fail closed on HTTP failures, malformed envelopes, unsafe continuation URLs, or loops; an incomplete comment scan must never mean "not already posted."
- **Quote Agent deduplicates interactions, not stories.** Repeated delivery of the same interaction must not post twice; a genuinely new mention, assignment, or reply should still get a quote. Serialize receipt checks and writes and use the remote comment marker to recover interrupted posts.
- **Safe diagnostics.** Bound outgoing request durations, report API method/path/status, and redact credentials, OAuth code/state, cursor values, and request content. Persist granted OAuth scopes without treating an older credential record's missing scope as a known grant.
