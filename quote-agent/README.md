# Quote Agent

A Cloudflare Worker that shows the interaction side of Shortcut Custom Agents. Installed in a workspace, it posts a random quote as a comment whenever someone assigns it a story or epic, @-mentions it, or replies to one of its comments.

For the platform itself (payload shapes, triggers, app review), see [docs/custom-agents.md](../docs/custom-agents.md).

## What it does

| Trigger | Response |
|---|---|
| Assigned a story or epic | Posts a quote as a comment |
| Mentioned in a top-level comment | Replies under that comment |
| Mentioned in a reply | Replies under the thread's root (threads are one level deep) |
| Reply to one of its comments | Replies in the same thread |
| Observer delivery | Acknowledged and ignored |

## How it works

- **Runtime**: Cloudflare Workers with Hono. OAuth credentials live in a KV namespace (`TOKENS`), one record per workspace.
- **Verification**: the worker caps the body at 2 MB, then `ShortcutWebhookClient.verifyBody` checks the signature and the delivery envelope before anything is parsed.
- **Coordination**: a SQLite Durable Object per workspace serializes interactions and stores a receipt for each completed delivery. A redelivered interaction does not post again; a new mention, assignment, or reply on the same story still gets a new quote.
- **Recovery**: before posting, the coordinator scans the entity's comments for one it already posted with this delivery's `external_id`. That recovers a post that succeeded before its receipt was saved. The scan uses `client.paginate` and fails closed, so an incomplete list never counts as "not posted".
- **Client**: `@shortcut/client` makes the API calls, refreshes the token through the demo's `refresh.run` callback, and walks cursor pages. The demo owns credential storage, receipts, and threading.

Failures return 503 without a receipt. The demo does not queue its own retries and does not guarantee exactly-once writes if a timed-out post is still in flight when the next attempt scans comments. Receipts are never pruned. Adapt it before running it under real traffic.

## Setup

You will move between a terminal in this directory and Shortcut's **Agents** page. Deploy first, because the worker's URL goes into the agent app.

1. Install dependencies and log in to Cloudflare:

   ```bash
   npm install
   npx wrangler login
   ```

2. Create the KV namespace. Copy the two printed ids into `wrangler.toml` as the `id` and `preview_id` of the `TOKENS` binding:

   ```bash
   npx wrangler kv namespace create TOKENS
   npx wrangler kv namespace create TOKENS --preview
   ```

3. Deploy. The checked-in `wrangler.toml` also creates the Durable Object. Note the URL wrangler prints:

   ```bash
   npx wrangler deploy
   ```

4. In Shortcut, open **Agents** in the sidebar and click **Add an agent** under **Agents Built By Your Organization**:

   - **Name**: your choice, for example "Wise Bot". **Handle**: `wise-bot`, the agent's username in the workspace and, because it is Mentionable, its @-mention name.
   - **OAuth Scopes**: Read and Write. The agent comments on epics as well as stories, and the narrower Create Comments scope covers only story comments.
   - **Capabilities**: Assignable and Mentionable, so the agent is told when it is assigned or mentioned. Replies to its comments are always delivered.
   - **Redirect URIs**: `https://<your-worker>.workers.dev/oauth/callback`

   After creating it, set the delivery settings:

   - **Webhook URL**: `https://<your-worker>.workers.dev/webhook`
   - **Subscribed entity types**: none

   Keep the client id, client secret, and webhook secret for the next step.

5. Push the secrets:

   ```bash
   echo "<client-id>"      | npx wrangler secret put CLIENT_ID
   echo "<client-secret>"  | npx wrangler secret put CLIENT_SECRET
   echo "<webhook-secret>" | npx wrangler secret put WEBHOOK_SECRET
   echo "https://<your-worker>.workers.dev/oauth/callback" \
                            | npx wrangler secret put REDIRECT_URI
   ```

   Until all four are set, `/webhook` and `/oauth/callback` return 503. Leave `SHORTCUT_API_BASE` unset in production.

6. Back on the agent app page, click **Activate** under **Activation**, then **Allow** on the consent page. Shortcut lands on the worker's `/oauth/callback`, which stores the credentials.

7. Run `npx wrangler tail` and look for `Quote Agent connected`. The line reports the granted scopes and the agent's `capabilities`, and a `Quote Agent capabilities are off` warning follows if Assignable or Mentionable was left off, since this demo answers both. `GET /` is a bare health check and says nothing about connected workspaces.

## Try it

1. @-mention the agent in a comment on a story. It replies in the thread with a quote.
2. Assign it a story or an epic. It posts a quote as a comment.

## Local development

Copy `.dev.vars.example` to `.dev.vars`, fill in the agent app's credentials with `REDIRECT_URI=http://localhost:8787/oauth/callback`, and run `npx wrangler dev`. Add that redirect URI to the agent app as a second entry. Signatures are always required, so either point a tunnel at the worker or sign test bodies yourself with the webhook secret.

Before deploying a change:

```bash
npm test
npx tsc --noEmit
npx wrangler deploy --dry-run
```

## Logging

API and OAuth requests time out after 15 seconds. A failure is logged as its method, endpoint path, status, and a provider error code when there is one. Bodies, query strings, tokens, OAuth codes and state, and comment text are never logged. Cloudflare's automatic invocation logs are off, but an interactive `wrangler tail` can still show callback URLs, so redact codes and state before sharing one.

## Quotes

Quotes come from `src/quotes.json`, bundled at deploy time. Edit the file and redeploy.
