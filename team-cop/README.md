# Team Cop

A Shortcut observer agent that comments when a Story is **created or started without a Team**:

> @name Stories need to be in a Team! Please add one!

It addresses the webhook actor (the creator or person who started the Story).
It re-reads the Story before commenting, and logs the actor, Story, Team, and
delivery IDs when a Team is already present. It never changes the workflow state.

See [Custom Agents](../docs/custom-agents.md) for payloads and installation concepts.

## Cloudflare deployment

Requires Node 22.13+ and a Cloudflare Workers account. Run from `team-cop/`:

```sh
npm ci
npx wrangler login
npm test
npm run deploy:check
npm run deploy
```

Wrangler creates the SQLite Durable Object binding automatically on first deploy.
There are no KV IDs to copy. The Worker URL will look like:

```text
https://shortcut-team-cop-agent.<your-subdomain>.workers.dev
```

Health works immediately. Webhooks and OAuth return 503 until the four secrets
below are configured. Production Shortcut (`https://api.app.shortcut.com`) is
the default API host.

### Configure Shortcut and secrets

Create or edit **Team Cop** from Shortcut's **Agents** page, under **Agents Built
By Your Organization**. You can reuse the existing production application.

- OAuth scopes: **Read** and **Create Comments**.
- Redirect URI: `https://<your-worker>.workers.dev/oauth/callback`.
- Webhook URL: `https://<your-worker>.workers.dev/webhook`.
- Subscribe to **Stories**, with no interaction triggers.

Save the settings. Add secrets using Wrangler's interactive prompts:

```sh
npx wrangler secret put CLIENT_ID
npx wrangler secret put CLIENT_SECRET
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put REDIRECT_URI
```

Use the same redirect URI in Shortcut and the `REDIRECT_URI` secret. Validate
the webhook, then Enable/install Team Cop and complete OAuth. If already enabled,
Disable and Enable again. On the consent screen, explicitly check **Create and
update story comments** as well as Read; comment access can start unchecked.

```sh
npm run tail
```

Look for `Team Cop connected` with `scopes: ['read', 'comment-write']`. The public
`GET /` endpoint reports service health; workspace scopes and queue counts are
in Worker logs. `Team Cop Worker initialized` appears when Cloudflare instantiates
the object, rather than on every request.

### Moving from localhost

Stop the old Node listener when switching the application's webhook URL. Update
both URLs to the Worker and complete fresh OAuth authorization. Local `.env` and
`.data/state.json` are **not uploaded**; they remain available for Node mode.
Previously queued local deliveries stay local and are not replayed in Cloudflare.
Test with a new teamless Story after connecting. Avoid running both endpoints
against the same events during migration, since their receipt stores are separate.

## Local development

To run the Cloudflare runtime locally:

```sh
cp .dev.vars.example .dev.vars
# Fill in the app credentials and your tunnel's /oauth/callback URL.
npm run dev
```

Wrangler serves port 8787. Point your tunnel at it, register the tunnel's webhook
and redirect URLs in Shortcut, and authorize once. Signatures are always required,
including locally. Local Durable Object state under `.wrangler/` is separate from
deployed state. Set `SHORTCUT_API_BASE` in `.dev.vars` only when intentionally
testing another environment.

The original Node listener is also available:

```sh
cp .env.example .env  # only for a fresh setup; preserve an existing .env
# Fill in credentials and the current tunnel callback URL.
npm start
```

It stores credentials and retries in `.data/state.json`. `.env`, `.dev.vars`,
`.data/`, and `.wrangler/` are ignored by Git. Existing local credentials/state
were preserved when this demo moved out of the monorepo scratch directory.

## How the Worker works

- Verifies the raw webhook body with HMAC-SHA256 before parsing or queueing.
- Persists each delivery and schedules a Durable Object alarm before returning
  HTTP 202. A single coordinator serializes API processing and token refresh.
- Processes Story creates and updates where `started` adds `true`. When the diff
  is unavailable, Team Cop cannot identify the transition and skips that update.
- Fetches only `team` from the Story and `mention_name` from the actor's Member.
- Ignores its own writes and persists processed action/delivery receipts. Before
  posting, the Worker scans comments for its own matching `external_id` to recover
  from a crash between the POST and receipt write.
- Allows one initial attempt plus **five retries**. Interrupted processing also
  consumes an attempt. Exhausted jobs remain in SQLite without further alarms
  for that job; redelivery does not reset the cap.
- Persists OAuth scopes and refreshes expiring tokens. Logs retain actor details
  on the Team-present skip message and safe OAuth diagnostics.

This is a reference demo for modest workspace traffic: one coordinator, paginated
comment checks, and retained receipts/exhausted payloads without automatic cleanup.
Comment checks reduce duplicates after interruptions, but the remote POST and local
receipt are not one atomic transaction.

Storage follows Cloudflare's [Durable Objects storage model](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/).

## Checks

```sh
npm test
npm run deploy:check
```

Tests cover Story selection, comments, actor logs, OAuth scopes/refresh, signed
webhooks, durable retry limits across restarts, duplicate deliveries, and recovery
from previously posted reminders. The deployment check bundles without publishing.
