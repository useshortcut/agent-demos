# Team Cop

A Shortcut observer agent that comments when a Story is **created or started without a Team**:

> @name Stories need to be in a Team! Please add one!

It addresses the webhook actor (the creator or person who started the Story),
but only if Team Cop has not already commented on that Story. Before posting,
it reads the Story's existing comments and checks their author against Team Cop's
member ID. It re-reads the Story before commenting and never changes the workflow
state.

See [Custom Agents](../docs/custom-agents.md) for payloads and installation concepts.

## Deployment

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

Create **Team Cop** from Shortcut's **Agents** page, under **Agents Built By Your
Organization**:

- OAuth scopes: **Read** and **Create Comments**.
- Redirect URI: `https://<your-worker>.workers.dev/oauth/callback`.
- Webhook URL: `https://<your-worker>.workers.dev/webhook`.
- Subscribe to **Stories**, with no interaction triggers.

Save the settings, then add the secrets using Wrangler's interactive prompts:

```sh
npx wrangler secret put CLIENT_ID
npx wrangler secret put CLIENT_SECRET
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put REDIRECT_URI
```

Use the same redirect URI in Shortcut and the `REDIRECT_URI` secret. Validate
the webhook, then enable Team Cop and complete OAuth. On the consent screen,
check **Create and update story comments** as well as Read.

```sh
npm run tail
```

Look for `Team Cop connected` with `scopes: ['read', 'comment-write']`. The public
`GET /` endpoint reports service health; workspace scopes and queue counts are
in Worker logs.

## Local development

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

## How it works

- Verifies the raw webhook body with HMAC-SHA256 before parsing or queueing.
- Persists each delivery and schedules a Durable Object alarm before returning
  HTTP 202. A single coordinator serializes API processing and token refresh.
- Processes Story creates and updates where `started` adds `true`. When the diff
  is unavailable, Team Cop cannot identify the transition and skips that update.
- Fetches only `team` from the Story and `mention_name` from the actor's Member.
- Ignores its own writes and persists processed action/delivery receipts. For each
  new qualifying event it scans the Story's comments for any non-deleted comment
  authored by Team Cop before posting. The comment history is the check; there is
  no permanent "already reminded" Story flag. If all Team Cop comments on a Story
  are deleted, a later qualifying event posts again. The scan follows v4's
  `next_page_url` cursor links, restricted to the same API origin and Story
  comments endpoint, and fails closed on incomplete or looping pagination rather
  than risk a duplicate reminder.
- Allows one initial attempt plus **five retries** with exponential backoff.
  Interrupted processing also consumes an attempt. Exhausted jobs remain in
  SQLite without further alarms for that job; redelivery does not reset the cap.
  Completed-delivery and action receipts are pruned after seven days.
- Persists OAuth scopes and refreshes expiring tokens.

For API failures, look for `Shortcut API request rejected` before the delivery's
retry log. It identifies the HTTP method, endpoint pathname, status, and sanitized
error details without logging authorization headers, query strings, or request
bodies. Exhausted deliveries remain failed after deployment; test a fix with a
new Story event rather than expecting the old delivery to restart automatically.
Deliveries that arrive before OAuth completes fail and are exhausted the same way,
so test with a new teamless Story after connecting.

Storage follows Cloudflare's [Durable Objects storage model](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/).

## Checks

```sh
npm test
npm run deploy:check
```

Tests cover Story selection, comment deduplication, actor logs, OAuth scopes and
refresh, signed webhooks, durable retry limits across restarts, duplicate
deliveries, receipt pruning, and recovery from previously posted reminders. The
deployment check bundles without publishing.
