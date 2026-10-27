# Devin Bridge

A Cloudflare Worker that joins Shortcut's agent sessions to [Devin](https://devin.ai). When someone assigns the agent a story or epic, @-mentions it, or replies to it, Shortcut opens an agent session. The bridge starts a Devin session for it, shows Devin's progress in the session card, and posts Devin's answer, question, or failure as the turn's outcome. Replies in Shortcut go back to the same Devin session.

It is a reference demo of a third-party agent on the agent-session protocol, not an official Devin integration. It uses one Devin organization and API key for every connected workspace, so anyone who can mention it can direct Devin at that organization's repositories. It serves only the workspaces listed in `ALLOWED_WORKSPACE_IDS`. Shortcut shows an unapproved agent app to every workspace in your organization, so the list is what keeps other workspaces off your Devin organization.

For the platform itself (OAuth, webhooks, app review), see [docs/custom-agents.md](../docs/custom-agents.md).

## What it does

| In Shortcut | In Devin |
|---|---|
| `session.created` (assigned, mentioned, or replied to) | Creates a session with the opening prompt, the story or epic link, and Shortcut's context. Links it on the card as **Open in Devin**. |
| Devin is working | Posts Devin's newest message as an ephemeral `thought` |
| Devin finished | `response` with Devin's last message, its pull requests, and the Devin link |
| Devin waits for the user | `elicitation` with Devin's question and the Devin link. The turn is handed back. |
| Devin waits for an approval | `elicitation` with Devin's question and the Devin link, posted once per question. The bridge keeps polling, so the result of an approval given in Devin still reaches Shortcut, and a later approval with a new message is asked again. |
| Devin errored, was suspended, or was terminated in Devin | `error` naming the condition |
| A reply (`session.prompted`) | Sends the reply into the same Devin session, or starts a new one if the bridge gave the last one up |
| Stop | Terminates the Devin session, then a `response` on the same turn. A reply that arrives while the stop is pending starts a new Devin session instead. |
| Shortcut closes the session | Terminates the Devin session and ignores later events, a stop included |

## How it works

### Runtime and objects

**Runtime.** The bridge runs on Cloudflare Workers with Hono and two SQLite-backed Durable Object classes. It uses no KV namespace, so setup has no namespace ids to paste.

**Workspace object.** Each Shortcut workspace has one, and it holds the OAuth credentials. Every session in a workspace shares one refresh token, and Shortcut rotates it on each refresh, so all refreshes go through this one object. A refresh request names the token that failed, and the object refreshes only if that token is still current. Two sessions that hit a 401 together therefore cause one refresh.

**Session object.** Each Shortcut session has one, keyed by the session id. The webhook verifies the signature and hands the event to the object. The object stores the event id and the event in an inbox and sets an alarm. It answers 200 only after that write, with no Shortcut or Devin call in between, so it stays inside Shortcut's 5 second delivery timeout. It acknowledges a redelivered event id and ignores it.

### The alarm loop

Each alarm applies new inbox events to the session state, then runs the jobs the state calls for. `src/bridge.ts` holds the state machine and the planner with no I/O, and `src/session.ts` performs the I/O.

The phases are `start`, `relay`, `poll`, `stop`, `idle`, and `closed`. A phase that acts on a Devin session carries its link, so no separate link can fall out of step with the phase.

One pure function, `plan` in `src/bridge.ts`, lists every due job and the earliest time it may run. When several jobs are due together, they run in this order:

1. A pending stop's terminate.
2. Retirement of a Devin session the bridge gave up.
3. The next Shortcut write from the outbox.
4. The **Open in Devin** link, while the card does not carry the current Devin session's link.
5. The quiet-poll read of the Shortcut session.
6. The phase's own Devin work: a start, a relay, or a poll.

The step runs the first due job, saves the state, and plans again until nothing is due now. It then sets the alarm to the earliest remaining time. Each job waits only on its own deadline (see [Failures](#failures)), so an unpublished outbox never holds Devin work and a Shortcut outage never delays a stop. The order means an acknowledgement posts before the slow Devin create. The terminate and retirement need only Devin, so they run before the bridge loads the Shortcut credentials.

**Spin guard.** No wait is shorter than one second, so a `Retry-After` of zero cannot run a job twice in one alarm. A job that changes nothing but a deadline and is due again at once is therefore a bug. The step then stops with an error, which the alarm logs and retries in a minute, so such a regression slows down instead of spinning. The step judges progress on the clock it read when the job returned, before the save, so a save that outlasts a one second wait does not look like a stall.

**Crash safety.** The step saves the state after each job, so a step that dies mid-publish does not repeat a Devin call. A start saves its intent before the create goes out, and a relay saves what it read before the send, so a retry of either knows what may already have happened. The state records the highest inbox sequence it applied, so a step that dies before clearing the inbox applies nothing twice.

### Events out of order

**Empty and non-text events.** The bridge ignores a reply whose content is not a text `prompt`. A `session.created` without text starts Devin on the story or epic alone.

**A reply before `session.created`.** Shortcut can deliver a reply before the `session.created` that opened the session. The bridge starts from the reply and keeps the context when the created event arrives. The opening request reaches only the first Devin session:

- If no create has gone out yet, the request goes into the create, whatever replies arrived meanwhile.
- If the create has gone out, the bridge sends the request to that session as a message once the session is known, with the context under a `Context from Shortcut` heading. It does this only while the turn that opened the session is still open.
- Once that turn has its outcome, or the bridge sent a newer reply, the bridge never sends the request. It sends the context alone, under the same heading, ahead of the next reply to that Devin session, so the session still learns about the story.
- A later Devin session gets the context only in its create prompt, so a request the user already stopped never comes back.

**Replies out of turn order.** The bridge keeps every reply it has not sent to Devin with its turn, and joins them in turn order when it sends them, whatever order they arrived in. The opening request has the lowest turn, so it comes first. Once the bridge sends a newer reply, it drops an older one however late it arrives. That includes a reply that arrived while the newer one was waiting to be resent.

**Stale stops.** A stop for an older turn can arrive after newer replies. If any of those replies is still unsent, the bridge terminates the Devin session first and then starts a new one with the replies after the stop's turn. The stop cancels the replies up to its turn. The bridge remembers that turn, even when no reply is left to restart, so a cancelled reply that Shortcut delivers again later stays cancelled. A stop that arrives while an earlier stop is pending cancels the replies waiting on that stop up to its turn, and the rest open the new session. A start whose create was already attempted counts too. The bridge terminates the session created under its tag, and the later replies open a new one. Once every later reply has been sent, such a stop is stale and the bridge ignores it.

### Outbox and idempotency keys

The bridge decides every Shortcut activity once, stores it in an outbox, and sends it until Shortcut accepts it. Retries resend the stored request byte for byte, so Shortcut treats them as replays.

Keys are `devin-bridge:{turn}:{suffix}`. The suffixes are `ack`, `ack:restart`, `restart`, `message:{devinEventId}`, `elicitation:{devinEventId}`, `elicitation:approval`, `elicitation:user`, `response`, `error`, `error:rejected`, and `stopped`. The turn is in the key because Shortcut keeps a key unique across all turns of a session.

Each suffix carries one body per turn, because Shortcut answers a reused key with a different body with a 409. So a stale stop's ack has its own suffix, since the turn's `ack` may already be posted with another text. An elicitation whose Devin message has no text is keyed by its kind.

The bridge cuts an outcome to Shortcut's 32,768 character body limit, footer included. A thought replaces the unpublished thought of its turn and goes to the end of the outbox, so activities reach Shortcut in the order the bridge produced them.

### Finding the Devin session again

Devin's create call has no idempotency key. The bridge tags each Devin session `shortcut-session-{shortcutSessionId}-{generation}` and looks the tag up before creating, so a retried start adopts the session an interrupted one created. The start records that it attempted a create before the call goes out. From then until the link is known, the tag stands in for the session.

A lookup returns every session under the tag. The start adopts the oldest and retires the rest, and a stop or a close terminates all of them. The bridge assumes a session Devin has created shows up in the list on a later lookup. It looks up a tag that finds nothing three times, 5 and then 10 seconds apart, before it believes the result.

The bridge relays a reply that arrives while a start is unresolved after it adopts or creates the session, instead of folding the reply into the create prompt. The generation increases each time a reply starts a new Devin session, so a later reply never adopts a stopped one.

### The Open in Devin link

The link is a Shortcut job of its own, due while the card does not carry the current Devin session's link. Setting it is best effort. The bridge sets it with the session's current `version` and retries once on a 409.

- A rate limit sets the Shortcut deadline, which holds the link too.
- A transient failure backs the link off on its own deadline, 5 seconds doubling to 60. After 8 failed attempts the bridge gives the link up, so an idle session is not woken for it again. That budget belongs to the Devin session, so a new Devin session's link starts with a full one.
- A failure for any other reason also gives the link up. The turn goes on, and the outcome activity still carries the Devin link.
- If Shortcut rejects a token refresh on the link's read, the turn ends, as on any other Shortcut call (see [Failures](#failures)).
- If Shortcut answers the read or write with a 401, 403, or 404, or the session carries a `closed_reason`, the session is gone. The bridge closes and retires the Devin session it just started.

The link never holds Devin work, and a link that is set resets the Shortcut failure count.

### Retirement

When the bridge gives a Devin session up, it does not forget it. The session, or the tag of an unresolved one, goes on a retire list. Each alarm terminates what is on the list until it is empty, in every phase including `closed`.

The bridge gives a session up when:

- a stop cannot terminate it,
- Devin rejects a relay or a poll with a 4xx other than 401 or 403,
- Devin reports the session errored or terminated,
- a reply reaches a session that has already ended,
- a tag lookup finds more than one session,
- or the Shortcut session closes.

A terminate that Devin answers with 404, 409, or 410 found nothing left to terminate. Any other 4xx, including a 401 or 403, is a failure. When a stop's terminate fails that way, or fails 8 times in a row, the stop still answers "Stopped." without claiming termination, or starts the next session, and retires the target.

Retirement has its own budget of 8 calls and its own backoff deadline, so it never holds the phase's Devin work and a Shortcut wait never holds it. A Devin 429 sets the shared Devin deadline and holds both. After 8 failed calls in a row the bridge drops the entry and logs a warning naming the Devin session id or tag.

### Polling

**Cadence.** The first poll is 5 seconds after a start or a relay. Each poll with no new Devin message doubles the delay, up to 60 seconds, and a new message resets it to 5 seconds. The bridge saves the poll's due time with the state, so a redelivered event, or one that changes nothing, never polls Devin early.

**When polling stops.** Polling stops once the turn has a `response`, an `error`, or an `elicitation` for a question Devin asks the user. An elicitation for an approval does not stop it. The approval happens in Devin, so the bridge records which question it asked and keeps polling. It asks again only when Devin waits with a new message, posts Devin's later progress, and ends the turn with Devin's answer. A wait that comes back on the same message is not written again.

**Quiet sessions.** While Devin is quiet at the 60 second cap, each poll also reads the Shortcut session. Polling stops if Shortcut ended the turn on its own (`complete`, `error`, `stale`, or a `closed_reason`), so the bridge does not poll a silent Devin session forever. That read is a Shortcut job of its own, due with the poll. It waits on the Shortcut deadline, not the Devin one. A 429 or a transient failure on it holds the read and not the poll, and a Devin failure in the poll after it keeps what the read learned.

**The baseline.** Right after a relay, Devin can still report the previous turn's finished or waiting status. So before it sends a reply, the bridge reads Devin's status and the id of the newest message, called the baseline. It saves them with the text the send carries. A retried send reuses the saved baseline and repeats the same text, so the bridge still finds an answer Devin gave to a send whose response was lost. A reply or a context that arrives after the baseline waits for the next relay. A relay that fails without reaching Devin keeps its late context for the next reply.

**The anchor.** The reply itself marks where fresh messages start. The anchor is the first message after the baseline that is not Devin's and whose body equals the reply. Failing that, it is the first message after the baseline that is not Devin's. Only Devin messages after the anchor are fresh. If the baseline id is no longer in the list, nothing is fresh.

**Pickup.** Devin has picked the reply up once a fresh message exists, or once its status differs from the status read at relay time. A status change for any other reason also counts, so the outcome can describe something other than the reply. Until pickup, Devin's status is not the new outcome. While Devin reports `working` with its status unchanged, the bridge keeps polling without limit. If the status is unchanged and not `working` for 10 minutes after the send went through, the turn ends with an `error`. The clock starts at the send, not at the baseline read, so a send held up by a Devin outage still gets its full wait. The bridge keeps the Devin session, so the next reply goes to it again. A cut-short message list still lets a status change count as pickup.

**Outcomes.** An outcome carries Devin's last fresh message, or a plain fallback such as "Devin finished." when there is none. A reply that reaches a session Devin reports as errored or terminated retires it and starts a new Devin session with the reply. A reply to a suspended session wakes it.

### Failures

**Waits.** A 429 from either API waits for `Retry-After` and does not count as a failure. The wait is 60 seconds when the header is absent, 10 minutes at most, and one second at least. Other server errors, timeouts, and network errors back off from 5 seconds, doubling to 60.

**Failure counts.** The phase's Devin work, Shortcut calls, retirement, and the card link each have their own failure count, and only that job's own success resets it. A Shortcut read that succeeds resets the Shortcut count, and a step that makes no Devin call leaves the Devin count alone. After 8 failed Devin calls in a row the bridge ends the turn with an `error` activity. The bridge never gives up a Shortcut write. It keeps retrying at 60 seconds, because replays are free and a turn Shortcut has ended answers 409.

**Deadlines.** A wait, whether a `Retry-After` or a backoff, is a deadline the session keeps per job:

- The Shortcut deadline holds Shortcut writes, the card link, and the quiet-poll session read.
- The Devin deadline holds every Devin call, including a stop's terminate and retirement.
- The retirement deadline holds retirement alone.
- The link deadline holds the card link alone.

No deadline holds another job. The bridge records an event that arrives during a wait at once and acts on it when the deadline it needs passes. So a stop during a Shortcut outage still terminates Devin at once, and Devin keeps working while Shortcut is down.

**Devin 4xx.** A Devin 4xx ends the turn with an `error` at once. A 401 or 403 is about the bridge's credentials, not the session, so the bridge keeps the Devin session. Any other 4xx retires the Devin session, and the next reply starts a new one.

**Shortcut 4xx.** The bridge retries a 408 or 425 from Shortcut like a server error. Any other 4xx except 401, 403, 404, 409, and 429 means Shortcut rejected the write itself. The bridge drops a rejected thought. It replaces a rejected outcome once with a short `error` naming the status, so the turn still ends.

**Shortcut 409.** A 409 means the turn is over. Shortcut ended it, a newer prompt replaced it, or the session closed. The bridge stops writing and polling for that turn and leaves the Devin session running for the next reply. A 409 on the ack of a reply not yet sent to Devin drops the ack, and the bridge reads the session:

- If Shortcut ended the turn on its own, the bridge drops the reply with it.
- Otherwise the bridge keeps the reply, because the event behind the 409, a newer reply or a stop, says what to do with it.
- If that read fails, the bridge drops the reply, so nothing reaches Devin for a turn Shortcut may have ended.

**Closed sessions.** A 401, 403, or 404 from Shortcut after a refresh means the session is gone. So does a `closed_reason` on the session, or a workspace that leaves `ALLOWED_WORKSPACE_IDS`. The bridge then retires the Devin session, or the tag of an unresolved start. It closes and ignores later events for the session, a stop included. Only the webhook treats a stop specially. It forwards a stop from a workspace that left the list while it drops that workspace's other events, so a session still open for that workspace closes and terminates Devin on the stop.

**Revoked grants.** A refresh that Shortcut rejects with a 400, such as `invalid_grant` after someone deactivates the agent, ends the turn and leaves Devin running. The bridge drops a reply not yet sent to Devin with the turn. Unlike a 409 on an open turn, no event follows to say what became of the reply, and nothing should reach Devin that Shortcut cannot see. Someone has to click **Activate** for the workspace again, and the next reply then reaches the same Devin session. The bridge retries a refresh that fails any other way like any transient failure.

### Write budget

Shortcut allows 60 writes a minute per session and 600 per installation, and replays are free. Polling posts at most one progress thought per poll, so a session writes at most 12 progress thoughts a minute. While Shortcut is down, a new thought replaces the unpublished thought of its turn in the outbox. The outbox therefore holds at most one thought per turn plus the outcomes, which the bridge never drops. Every session in the workspace shares the installation budget, and sessions do not coordinate, so fifty busy sessions can reach it. The 429 then waits for `Retry-After` like any other.

### Why progress is ephemeral

The protocol defines `thought` and `action` as progress that the next activity supersedes. Devin can send dozens of messages in a run, and the full transcript stays in Devin behind **Open in Devin**. The bridge posts only Devin's newest message per poll, as an ephemeral thought, so the card shows what Devin is doing now. The turn's outcome (`response`, `elicitation`, or `error`) carries Devin's latest message and is permanent.

### Assumptions where Devin's docs are silent

- **`exit` status.** The v3 spec lists `exit` without describing it. The bridge treats it as a session terminated outside the bridge and starts a new one on the next reply.
- **Unknown statuses.** Any status or `status_detail` the bridge does not recognize counts as working, so it keeps polling.
- **Tag filter encoding.** The spec has a `tags` filter on the session list but does not say how arrays are encoded. The bridge sends `tags=` once and checks the tag on each returned session, so a server that ignores the filter cannot make it adopt the wrong session. It follows `has_next_page` for up to 5 pages of 100 and collects every match. If no page matches and more remain, it logs a warning and creates a session. Only the tagged sessions have to parse. A page without a boolean `has_next_page`, a page that claims a next page without a string `end_cursor`, or a tagged session that does not parse counts as a transient failure, so none of them authorizes a create. Matches are ordered by `created_at`, read as a number or a date string, and a session without one sorts last. The spec does not say that a created session is visible in the list at once, so a tag that finds nothing is looked up again (see [Finding the Devin session again](#finding-the-devin-session-again)).
- **Empty replies.** Sending a message and terminating a session are treated as done on any 2xx, with or without a body.
- **Message order and shape.** The bridge assumes the message list is oldest first, and that each item carries `event_id`, `source`, and `message`. It reads sessions 100 at a time and messages 200 at a time.
- **Message cursors.** The docs do not say whether a stored cursor can tail the message list. Each poll reads the list from the start, up to 10 pages of 200, and finds the messages after the last one it posted. A list that runs past that cap, whose page has no boolean `has_next_page`, that claims a next page without a cursor, or that holds an item without a string `event_id` and `source`, is cut short. The poll then posts no progress, an outcome uses the plain fallback text, and the worker logs one warning per poll.
- **Message sources.** Only messages with `source` `devin` are Devin's. The bridge finds the reply it sent by body among the messages after its baseline that are not Devin's, whatever source Devin records it under, and falls back to the first such message. It uses it to place Devin's later messages.
- **Rate limits.** Every endpoint documents 429 without numbers or `Retry-After`. The bridge honors `Retry-After` if Devin sends it, at least one second, and waits 60 seconds otherwise.
- **Relays.** Sending a message has no idempotency key either, so a step interrupted after the send can deliver the reply to Devin twice.

## Setup

You will move between a terminal in this directory, Devin, and Shortcut's **Agents** page. Agent sessions must be enabled for the Shortcut workspace (the Agent Sessions platform). Deploy first, because the worker's URL goes into the agent app.

1. Install dependencies and log in to Cloudflare:

   ```bash
   npm install
   npx wrangler login
   ```

2. Deploy. The checked-in `wrangler.toml` creates both Durable Objects. Note the URL wrangler prints:

   ```bash
   npx wrangler deploy
   ```

3. In Devin, open **Settings** > **Devin API** > **Service users** and create a service user API key. It starts with `cog_`. The organization id is at the top of that page.

4. In Shortcut, open **Agents** in the sidebar and click **Add an agent** under **Agents Built By Your Organization**:

   - **Name**: your choice, for example "Devin Bridge". **Handle**: `devin-bridge`, so it does not collide with the built-in `devin-ai` app.
   - **OAuth Scopes**: **Read** and **Write**. Session writes need Write.
   - **Capabilities**: **Assignable** and **Mentionable**.
   - **Redirect URIs**: `https://<your-worker>.workers.dev/oauth/callback`

   After creating it, set the delivery settings:

   - **Webhook URL**: `https://<your-worker>.workers.dev/webhook`. Do not click **Validate** yet. The worker answers it only once the secrets in the next step are set.
   - **Entity Type Subscriptions**: none.

   Keep the **Client ID**, **Client Secret**, and **Webhook Signing Secret** for the next step.

5. Push the secrets:

   ```bash
   echo "<client-id>"      | npx wrangler secret put CLIENT_ID
   echo "<client-secret>"  | npx wrangler secret put CLIENT_SECRET
   echo "<webhook-secret>" | npx wrangler secret put WEBHOOK_SECRET
   echo "https://<your-worker>.workers.dev/oauth/callback" \
                            | npx wrangler secret put REDIRECT_URI
   echo "<cog_...>"        | npx wrangler secret put DEVIN_API_KEY
   echo "<org-id>"         | npx wrangler secret put DEVIN_ORG_ID
   echo "<workspace-id>"   | npx wrangler secret put ALLOWED_WORKSPACE_IDS
   ```

   `ALLOWED_WORKSPACE_IDS` is a comma-separated list of the Shortcut workspace ids the bridge serves. If you don't know your workspace's id, set any placeholder, click **Activate** in step 6, and the refusal page shows the id to add. `/oauth/callback` returns 503 until all seven are set. `/webhook` needs only the first six. An unset or empty list allows no workspace, but a stop still reaches a session the bridge knows, so clearing the list keeps Devin cleanup working. Leave `SHORTCUT_API_BASE` unset in production. Set `DEVIN_API_BASE` only for a Devin Enterprise domain.

6. Back on the agent app page, click **Validate** next to the webhook URL. Then click **Activate** under **Activation**, then **Allow** on the consent page. A workspace that is not in `ALLOWED_WORKSPACE_IDS` gets a 403 page naming its id, and nothing is stored. Otherwise the worker stores the credentials and then turns on agent sessions for the installation (`PUT /api/v4/{workspace}/agent-sessions/subscription`). If that second step fails, the page says so with a 502. Click **Activate** again to retry. Activating again keeps the original activation position.

7. Run `npx wrangler tail` and look for `Devin Bridge connected`. It reports the granted scopes and `sessionsEnabled`. A `Devin Bridge needs the Read and Write scopes` warning follows if either scope is missing. `GET /` is a bare health check and says nothing about connected workspaces.

## Try it

1. @-mention `@devin-bridge` in a comment on a story with a small, concrete request. The session card shows "Starting a Devin session." and then Devin's progress, and gains an **Open in Devin** link.
2. When Devin asks a question or finishes, reply in the session. The reply goes to the same Devin session.
3. Stop the session from the card. The bridge terminates the Devin session and answers "Stopped."

## Local development

Copy `.dev.vars.example` to `.dev.vars`, fill in the agent app's credentials with `REDIRECT_URI=http://localhost:8787/oauth/callback` and your Devin key and org id, and run `npx wrangler dev`. Add that redirect URI to the agent app as a second entry. Signatures are always required, so either point a tunnel at the worker or sign test bodies yourself with `signShortcutWebhookHeaders` from `@shortcut/client/webhooks` and the webhook secret.

Before deploying a change:

```bash
npm test
npx tsc --noEmit
npm run test:runtime
npx wrangler deploy --dry-run
```

## Logging

Shortcut and Devin requests time out after 15 seconds. A Shortcut failure is logged as its method, endpoint path, status, and a provider error code when there is one. A Devin failure is logged as its method, path, and status. Response bodies, query strings, tokens, the Devin key, OAuth codes and state, prompt text, and Devin's messages are never logged. Cloudflare's automatic invocation logs are off, but an interactive `wrangler tail` can still show callback URLs, so redact codes and state before sharing one.
