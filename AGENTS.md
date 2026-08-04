# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## What this repo is

Reference implementations for Shortcut Open Agents — web services that receive signed webhooks from a Shortcut workspace and call back into the Shortcut v4 API. Each demo lives in its own top-level directory with its own `package.json` and README, and is meant to be small, readable end to end, and focused on one idea (per the root README's contributing note — not production-ready).

- `guardian/` — observer-only agent: blocks stories from being started without a team (comments at the mover, reverts the state).
- `quote-agent/` — interaction-triggered agent: posts a random quote when assigned, @-mentioned, or replied to. Shows the full lifecycle including threaded replies.
- `docs/open-agents.md` — the platform reference: payload shapes (observer vs. interaction envelopes), trigger semantics, review lifecycle. Read this before touching webhook-handling code.

## Commands

Run everything from inside the demo directory you're working on (`guardian/` or `quote-agent/`):

```bash
npm install
npm run dev          # wrangler dev --local, serves http://localhost:8787
npm run deploy       # wrangler deploy
npx tsc --noEmit     # type check (strict mode; no lint or test setup exists)
```

Local dev needs `.dev.vars` (copy from `.dev.vars.example`). `DEV=true` downgrades webhook signature failures to warnings instead of 401s. `SHORTCUT_API_BASE` overrides the API host for local testing. Neither should be set in production.

Deployment also requires a KV namespace (`npx wrangler kv namespace create TOKENS`, ids go in `wrangler.toml`) and secrets pushed via `npx wrangler secret put` (CLIENT_ID, CLIENT_SECRET, WEBHOOK_SECRET, REDIRECT_URI). See each demo's README for the full sequence.

## Architecture

Both demos are single-file Cloudflare Workers (`src/index.ts`) using Hono, and share the same skeleton:

- **Endpoints**: `GET /oauth/callback` (token exchange), `POST /webhook` (delivery receiver), `GET /` (health + stored-credential summary).
- **Storage**: one KV namespace bound as `TOKENS`. Credentials are stored per workspace at `creds:{workspace_id}` as `{token, slug, refreshToken, expiresAt, memberId}`. `memberId` is the agent's own `permission_id` from the OAuth token response.
- **Auth**: OAuth authorization-code flow against `/oauth-authorization-code-flow/token`. Tokens are refreshed proactively when within 5 minutes of expiry and reactively on a 401 (see `apiFetch` in guardian).
- **Webhook verification**: HMAC-SHA256 over the raw request body, hex digest in the `Payload-Signature` header. Always verify before parsing/acting.
- **API base**: `https://api.app.shortcut.com/api/v4/{workspace_slug}/...`. List endpoints are page-based envelopes (`entities`, `current_page`, `total_pages`), default 10 per page.

### Invariants that matter when editing

- **Observer payloads carry no diff.** An action says an entity changed, not what changed. Current state comes from re-reading the entity; previous state from `GET /stories/{id}/history`. A history entry's `removes` is only trustworthy when its `adds[0].id` matches the entity's current value — otherwise it describes an older change.
- **Agents see their own writes.** Every write comes back as a fresh observer delivery. Two defenses, both required: drop deliveries where `actor.member_id` equals the stored `memberId`, and check for the durable effect of a past run (guardian scans for its own warning comment via `WARNING_MARKER`) so retries/restarts can't double-write.
- **`fields` query params are load-bearing.** Every v4 endpoint takes `fields`; unrequested fields are never calculated, and unknown field names are a 400 (not ignored). In guardian, each `*_FIELDS` constant sits directly above the TypeScript type it fills — change one, change the other. Writes request `fields=id` only.
- **Guardian's ordering: comment before revert.** If the comment fails, the revert is skipped — an unexplained revert would repeat on every subsequent update because there'd be no comment to find. The webhook handler returns immediately; all API work runs via `c.executionCtx.waitUntil`.
- **Don't cache failure.** Guardian caches started-state ids in KV for an hour, but never caches an empty lookup result — that would silently disable the agent.
