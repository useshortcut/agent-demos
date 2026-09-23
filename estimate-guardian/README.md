# Estimate Guardian

A Cloudflare Worker that enforces one rule: **a story can't be started without an estimate.**

When someone moves an unestimated story into a started state, Estimate Guardian comments on the story and moves it back:

> @ada Stories need an estimate before being started! Please add an estimate and start again!

It warns once per story. An estimate of 0 counts as estimated. Removing the estimate from a started story also triggers the check. This is a webhook rule, not a block in the UI, so the story does move for a moment before it bounces back.

For Team reminders that never change state, see [Team Cop](../team-cop). For the platform itself (payload shapes, triggers, app review), see [docs/custom-agents.md](../docs/custom-agents.md).

## How it works

Estimate Guardian subscribes to observer deliveries for stories. For each story `update` it:

1. Skips the delivery if the actor is Estimate Guardian itself.
2. Skips it if the action's `changes` touched neither `workflow_state` nor `estimate`. Most updates end here, with no API call.
3. Re-reads the story, and skips it if it has an estimate or is not in a started state.
4. Skips it if the story already carries a warning comment.
5. Posts the warning, addressed to the actor's `mention_name` from the delivery.
6. Moves the story back to the state it came from.

Steps 3 to 6 run in a Durable Object keyed by workspace and story, so duplicate deliveries queue instead of racing. The webhook is acknowledged only after the first attempt has finished or its recovery has been saved.

The Shortcut plumbing comes from [`@shortcut/client`](https://www.npmjs.com/package/@shortcut/client): `ShortcutV4Client` makes the API calls, follows cursor pages, and refreshes the token; `ShortcutOAuth` handles the install and the refresh; `ShortcutWebhookClient` verifies the signature and the delivery envelope. The demo owns the rule, its recovery, credential storage, and logging.

### Where the facts come from

| Question | Source |
|---|---|
| Did anything relevant change? | the action's `changes` |
| Where did the story come from? | the `workflow_state` entry's `removes[0].id`, or `GET /stories/{id}/history` when `changes` is absent |
| Does it have an estimate, and what state is it in? | `GET /stories/{id}?fields=estimate,workflow_state` |
| Is that a started state? | `GET /workflow-states?fields=id,type`, cached per workspace for an hour |
| Who moved it? | `actor.mention_name` on the delivery |

The story is always re-read, because a delivery describes the story as it was, not as it is now. A previous state is trusted only when the entry's `adds[0].id` matches the story's current state; otherwise the story has moved again and the entry is stale.

An absent `changes` key means the diff was unavailable, not that nothing changed. Estimate Guardian then checks the story regardless and reads the previous state from story history, which has the same shape.

### Why it doesn't loop

Its own comment and revert come back as new deliveries. Three checks stop the loop: the actor check in step 1, the existing-warning check in step 4, and the fact that a reverted story is no longer in a started state.

The comment is posted before the revert. If the comment fails, the revert is skipped, because a silent revert would look like the story moving on its own.

### Recovering a failed revert

The comment and the revert are two API calls. Before posting, the coordinator saves the operation, the expected current and previous states, and a unique comment `external_id`. If the revert fails, a Durable Object alarm retries it up to five times with backoff, within five minutes, re-reading the story before each attempt. A new estimate, a different state, or a newer relevant delivery cancels the operation. The warning is never posted twice: if the comment's response was lost, recovery continues only after finding that exact comment.

### Known gaps

- Only story `update` actions are handled. A story created directly into a started state is not caught until its next relevant update.
- Deleting the warning comment re-arms the rule, because the comment is the record.
- Lookups that fail before an operation is saved are logged and dropped, not retried.
- The final read and the revert are not atomic, so someone can edit in between.

## Requests it makes

Every call asks only for the fields it needs. A story that bounces costs five requests:

```
GET   /stories/123?fields=estimate,workflow_state
GET   /stories/123/comments?fields=text,author,deleted,external_id&limit=100
POST  /stories/123/comments?fields=id
GET   /stories/123?fields=estimate,workflow_state
PATCH /stories/123?fields=id
```

A move that turns out to be fine costs one. Unknown field names are a 400, so each `*_FIELDS` constant in `src/index.ts` sits next to the type it fills; edit them together.

Lists go through `client.paginate`, which fails closed on a rejected page or an unsafe link. Estimate Guardian never treats an unavailable comment list as "no warning yet".

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

3. Deploy. The checked-in `wrangler.toml` also creates the Durable Object used for recovery. Note the URL wrangler prints:

   ```bash
   npx wrangler deploy
   ```

4. In Shortcut, open **Agents** in the sidebar and click **Add an agent** under **Agents Built By Your Organization**:

   - **Name**: Estimate Guardian. **Handle**: `estimate-guardian`.
   - **OAuth Scopes**: Read, Create Stories (to move stories back), and Create Comments.
   - **Capabilities**: none. The agent only watches stories; nobody needs to assign or mention it.
   - **Redirect URIs**: `https://<your-worker>.workers.dev/oauth/callback`

   After creating it, set the delivery settings:

   - **Webhook URL**: `https://<your-worker>.workers.dev/webhook`, then click **Validate**. Entity type subscriptions stay disabled until the URL answers Shortcut's validation ping with a 2xx, which the worker does out of the box.
   - **Subscribed entity types**: story

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

6. Click **Activate** under **Activation** on the agent app page. Shortcut runs the OAuth flow and lands on the worker's `/oauth/callback`, which stores the credentials.

7. Run `npx wrangler tail` and look for `Estimate Guardian OAuth connected`. `GET /` is a bare health check and says nothing about connected workspaces.

## Try it

1. Create a story with no estimate.
2. Move it to a started state.
3. It bounces back within a second or two, with a comment tagging you.
4. Give it an estimate (0 is fine) and start it again. It stays, with no second comment.

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
