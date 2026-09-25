# Team Cop

A Shortcut observer agent that comments when a story is **created or started without a Team**:

> @name Stories need to be in a Team! Please add one!

It addresses whoever created or started the story, comments at most once per story, and never changes the workflow state. For a rule that does move stories back, see [Estimate Guardian](../estimate-guardian). For the platform itself, see [docs/custom-agents.md](../docs/custom-agents.md).

## How it works

- Verifies each webhook's signature over the raw body, then saves the delivery and schedules a Durable Object alarm before returning 202. One coordinator processes deliveries in order.
- Acts on story `create` actions and on `update` actions whose `changes` mark the story as started. When the diff is unavailable, it cannot tell and skips the update.
- Reads only `team` from the story, and takes the actor's `mention_name` from the delivery.
- Before posting, scans the story's comments for one it already wrote. The comments are the record: if they are all deleted, a later qualifying event posts again. The scan uses `client.paginate` and fails closed rather than risk a duplicate.
- Ignores its own writes and keeps a receipt for each processed action and delivery. Receipts are pruned after seven days, and every queue and receipt lookup is indexed, so a busy workspace stays inside the Durable Objects free tier's daily `rows_read` allowance.
- Retries a failed delivery up to five times with exponential backoff, then leaves it in SQLite without further alarms. Redelivery does not reset the cap.
- Uses `@shortcut/client` for API calls, token refresh through its `refresh.run` callback, and pagination. Team Cop itself is plain JavaScript on a SQLite Durable Object; no Hono, no KV.

## Setup

Requires Node 22.13 or newer and a Cloudflare account. From this directory:

1. Install, log in, and deploy. Wrangler creates the Durable Object on first deploy; there are no KV ids to copy.

   ```sh
   npm ci
   npx wrangler login
   npm test
   npm run deploy
   ```

   Note the URL wrangler prints, in the form `https://shortcut-team-cop-agent.<your-subdomain>.workers.dev`.

2. In Shortcut, open **Agents** in the sidebar and click **Add an agent** under **Agents Built By Your Organization**:

   - **Name**: Team Cop. **Handle**: `team-cop`.
   - **OAuth Scopes**: Read and Create Comments.
   - **Capabilities**: none. The agent only watches stories; nobody needs to assign or mention it.
   - **Redirect URIs**: `https://<your-worker>.workers.dev/oauth/callback`

   After creating it, set the delivery settings:

   - **Webhook URL**: `https://<your-worker>.workers.dev/webhook`, then click **Validate**. Entity type subscriptions stay disabled until the URL answers Shortcut's validation ping with a 2xx, which the worker does out of the box.
   - **Subscribed entity types**: story

   Keep the client id, client secret, and webhook secret for the next step.

3. Push the secrets. Wrangler prompts for each value:

   ```sh
   npx wrangler secret put CLIENT_ID
   npx wrangler secret put CLIENT_SECRET
   npx wrangler secret put WEBHOOK_SECRET
   npx wrangler secret put REDIRECT_URI
   ```

   `REDIRECT_URI` must match the redirect URI saved in Shortcut. Until all four are set, `/webhook` and `/oauth/callback` return 503.

4. Click **Activate** under **Activation** on the agent app page. On the consent screen, allow Read and **Create and update story comments**.

5. Run `npm run tail` and look for `Team Cop connected` with `scopes: ['read', 'comment-write']`. `GET /` is a bare health check; workspace and queue details are in the logs.

## Try it

Create a story with no Team, or start one that has none. Within a few seconds Team Cop comments on it, addressed to you. Add a Team and start it again: nothing happens.

Deliveries that arrive before OAuth completes fail and are exhausted, so test with a new story after connecting.

## Local development

```sh
cp .dev.vars.example .dev.vars   # fill in the app credentials and your tunnel's /oauth/callback URL
npm run dev
```

Wrangler serves port 8787. Point a tunnel at it, register the tunnel's webhook and redirect URLs on the agent app, and authorize once. Signatures are always required. Local Durable Object state under `.wrangler/` is separate from deployed state. Set `SHORTCUT_API_BASE` only when deliberately testing another environment.

## Checks

```sh
npm test
npm run deploy:check
```

Tests cover story selection, comment deduplication, actor handling, OAuth scopes and refresh, signed webhooks, retry limits across restarts, duplicate deliveries, receipt pruning, and recovery from earlier reminders. The deploy check bundles without publishing.

## Logging

A failed API call is logged as `Shortcut API request rejected` with its method, endpoint path, status, and a provider error code when there is one. Bodies, query strings, tokens, and comment text are never logged. Exhausted deliveries stay failed after a redeploy; test a fix with a new story event.
