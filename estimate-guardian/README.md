# Estimate Guardian

A Cloudflare Worker that enforces one workspace rule: **a story can't be started without an estimate.**

When a story moves into a started workflow state while its estimate is empty, Estimate Guardian comments on the story tagging whoever moved it, then moves the story back to the state it came from. It does this at most once per story.

> `@ada Stories need an estimate before being started! Please add an estimate and start again!`

An Estimate of **0 is valid**. Only an explicit `null` Estimate means unestimated; an unavailable/malformed Estimate field is not grounds for a revert. Team membership is irrelevant to this rule. Removing an Estimate from an already-started Story also triggers a check. This is a reactive webhook rule, not a synchronous block in the Shortcut UI.

For Team membership reminders without state changes, use [Team Cop](../team-cop).

For background on the platform — payload shapes, trigger semantics, and the app review lifecycle — see [../docs/custom-agents.md](../docs/custom-agents.md).

---

## How it works

Estimate Guardian subscribes to **observer** deliveries for the `story` entity type. On each `update` action it:

1. Ignores the delivery if the actor was Estimate Guardian itself.
2. Checks the action's `changes`. If neither `workflow_state` nor `estimate` changed, stops — without calling the API.
3. Re-reads the story. If it has an estimate, stops.
4. Looks up whether the story's workflow state is of type `started`. If not, stops.
5. Scans the story's comments for a warning it already left. If found, stops.
6. Resolves the actor's `mention_name` and posts the warning comment.
7. Takes the state the story came from out of `changes`, and moves it back.

Steps 3–7 run in a Durable Object keyed by workspace and Story, serializing duplicate deliveries. The webhook waits for the coordinator to finish its first attempt; any incomplete warning/revert has durable recovery progress and an alarm before the webhook acknowledges success.

### Reading the diff

A story update action carries the transaction's diff in `changes`, one entry per tracked attribute, in the same shape as the v4 story history API:

```json
{ "action": "update", "id": 123, "entity_type": "story",
  "global_id": "v2:s:<workspace-id>:123", "app_url": "https://app.shortcut.com/...",
  "changes": [
    { "attribute": "workflow_state",
      "adds":    [{ "entity_type": "workflow-state:slim", "id": 500000002, "name": "In Development" }],
      "removes": [{ "entity_type": "workflow-state:slim", "id": 500000001, "name": "Ready" }] }
  ] }
```

That answers two of Estimate Guardian's questions from the payload alone. *Did this update touch anything I care about?* — only if there's a `workflow_state` or `estimate` entry, so the great majority of story updates (description edits, comments, Teams, owners) are dropped before any request is made. *Where did the story come from?* — `removes[0].id` of the `workflow_state` entry.

The rest is still re-read, because the delivery is handled asynchronously and describes the story as it *was*, not as it is now:

| Question | Source |
|---|---|
| Does it have an estimate? | `GET /stories/{id}` → `estimate` |
| What state is it in? | `GET /stories/{id}` → `workflow_state` (slim — no `type`) |
| Is that state a *started* state? | `GET /workflow-states` → `type`, cached per workspace for an hour |
| Where did it come from? | `changes` → `workflow_state` entry → `removes[0].id` |
| Who moved it? | `GET /members/{actor.member_id}` → `mention_name` |

The `workflow_state` entry is only trusted when its `adds[0].id` matches the story's current state. Otherwise the story has moved again since the delivery was queued, and reverting to that entry's `removes` would send it somewhere it never was.

#### When `changes` is missing

An absent `changes` key means the diff was **unavailable** for that delivery — the payload hit a size limit, or rendering failed for that story — and never that nothing changed. Estimate Guardian then does what it did before the field existed: it checks the story regardless of what changed, and reconstructs the previous state from `GET /stories/{id}/history?fields=workflow_state&limit=1`. History entries have the same `attribute` / `adds` / `removes` shape, so the same code reads both, with the same rule about matching `adds` first. The history path also covers an `estimate` change on a story that was already started, where there is no move in the delivery to read.

### Asking for as little as possible

Every v4 endpoint takes a `fields` query param, and unrequested fields are never calculated — a story rendered whole resolves its description markdown and every nested collection. The first call here runs for *every move or estimate change in the workspace*, so it matters. One story bouncing looks like this end to end:

```
GET   /stories/123?fields=estimate,workflow_state
GET   /stories/123/comments?fields=text,author,deleted,external_id&limit=100
GET   /members/{actor}?fields=mention_name
POST  /stories/123/comments?fields=id
GET   /stories/123?fields=estimate,workflow_state
PATCH /stories/123?fields=id
```

Updates that don't touch the workflow state or estimate cost nothing; moves and estimate changes that turn out to be fine cost exactly one two-field story read. Writes ask for `id` alone — just enough to tell success from failure.

List requests follow `next_page_url` cursors, retaining the requested `fields` and omitting `limit` after the first page. Cursor URLs must stay on the same API origin and endpoint. Failed, malformed, incomplete, or looping lists stop processing: Estimate Guardian never treats an unavailable comment list as "no warning," nor caches a partial workflow-state list. The versioned state-cache key bypasses potentially partial caches written by earlier releases.

Single-entity API responses are unwrapped from `{ entity: ... }`; list envelopes remain intact for pagination.

Unknown field names are a **400**, not a silently ignored param, so each `*_FIELDS` constant in `src/index.ts` sits directly above the type it fills and the two are meant to be edited together.

### Not reacting to itself

Estimate Guardian's own comment and its own revert both come back as fresh observer deliveries. Three things stop the loop:

- **Actor check** — deliveries where `actor.member_id` is Estimate Guardian's own member id are dropped immediately.
- **Comment check** — a story that already carries the warning is left alone. This is also what makes the rule fire once per story rather than once per move.
- **State check** — after a revert the story is no longer in a started state, so the next delivery exits at step 4 anyway.

The comment is posted *before* the revert. If commenting fails, the revert is skipped — an unexplained revert would look like the story moving on its own, and with no comment to find, it would repeat on every subsequent update.

### Recovering a failed revert

Posting a warning and changing a Story are separate API calls. Estimate Guardian persists the original delivery, expected current/previous workflow states, and a unique comment `external_id` before posting. A confirmed warning is recorded separately from a completed revert. If the PATCH fails or its response is lost, a Durable Object alarm resumes that operation without posting another warning or waiting for another webhook.

Recovery is bounded to the initial attempt plus five retries (2, 4, 8, 16, and 32 seconds of backoff), with a five-minute deadline. Each retry re-reads the Story immediately before its PATCH; an Estimate or a different workflow state cancels the old operation. A different observed move/estimate-edit delivery also cancels it, even if the state now happens to match again. An ordinary pre-existing warning is never permission to revert a later unrelated move. Completed, superseded, or exhausted operations cancel their alarm and retain one last-operation record per Story, so that delivery cannot restart them while it remains the last operation.

If the POST response is ambiguous, Estimate Guardian only proceeds after finding its own non-deleted comment with that operation's exact `external_id`. It never retries the POST: a crash just before posting can therefore leave a Story unguarded, rather than risk duplicate comments. Once a warning was confirmed, deleting it during recovery does not trigger another comment. After the operation finishes, a new delivery can rearm the rule if the warning has been deleted.

The final Story read and PATCH are not an atomic compare-and-set: a user can still edit between them. Recovery cannot detect intermediate moves away and back to the same state if their deliveries have not arrived. Its short window and operation-specific progress bound this risk; logs report `reverted`, `superseded`, `exhausted`, or `warned-only` outcomes. OAuth credentials remain in the original KV namespace.

### Known gaps

- **Lookups before an operation is prepared are not durably queued.** Failed Story/state/comment lookups stop processing and are logged; some return a failed webhook response, while an unavailable Story returns success without acting. Durable alarms cover prepared warning/revert operations, not every observer delivery.
- **Story create actions are ignored**, including stories created directly into a started state: Estimate Guardian only processes qualifying update actions. A later qualifying update can trigger a warning; if no trustworthy previous state can be found then, Estimate Guardian warns without moving the story. Enforcing the rule at creation would require handling create actions and choosing a destination state rather than restoring one.
- **Deleting the warning comment re-arms the rule.** The comment *is* the record. A KV flag keyed by story id would survive deletion, at the cost of the state being invisible to anyone reading the story.
- **A rename of the marker sentence orphans old warnings**, since matching is on visible text. That's the trade for not putting hidden markup in people's comments.

---

## Setup

Setup bounces between two places: a terminal in this directory, and Shortcut's **Agents** page. The worker gets deployed first, because its URL is part of the agent app's configuration in Shortcut.

### 1. Install dependencies and log in to Cloudflare

```bash
npm install
npx wrangler login
```

### 2. Create the KV namespace

```bash
npx wrangler kv namespace create TOKENS
npx wrangler kv namespace create TOKENS --preview
```

Each command prints an id — copy them into `wrangler.toml` as the `id` and `preview_id` of the existing `TOKENS` binding.

### 3. Deploy the worker

Deploy the checked-in `wrangler.toml` together with the code. Its `ESTIMATE_GUARDIAN_STORIES` binding and `v1` migration create the SQLite Durable Object used for recovery automatically. OAuth credentials are stored in the `TOKENS` KV namespace configured above.

```bash
npx wrangler deploy
```

Note the URL wrangler prints — `https://shortcut-estimate-guardian-agent.<your-subdomain>.workers.dev`. The next two steps need it. (The worker can't do anything useful yet; its secrets are still missing.)

### 4. Create the agent app in Shortcut

In Shortcut:

1. Click **Agents** in the sidebar.
2. Under **Agents Built By Your Organization**, click **Add an agent**.
3. Fill out the **New Application** form:
   - **Name**: **Estimate Guardian**. **Mention Handle**: `estimate-guardian`. Icon and descriptions are optional.
   - **OAuth Scopes**: **Read**, plus **Create Stories** (Estimate Guardian updates stories to move them back) and **Create Comments** (it posts the warning comment).
   - **Redirect URIs**: `https://<your-worker>.workers.dev/oauth/callback`
4. Click **Create Application**, then set the delivery settings on the application:
   - **Webhook URL**: `https://<your-worker>.workers.dev/webhook`
   - **Subscribed entity types**: `story`
   - **Interaction triggers**: none — Estimate Guardian is observer-only

Creating the app gives you its **client id**, **client secret**, and **webhook secret** — keep them at hand for the next step.

### 5. Push the secrets

```bash
echo "<client-id>"      | npx wrangler secret put CLIENT_ID
echo "<client-secret>"  | npx wrangler secret put CLIENT_SECRET
echo "<webhook-secret>" | npx wrangler secret put WEBHOOK_SECRET
echo "https://<your-worker>.workers.dev/oauth/callback" \
                         | npx wrangler secret put REDIRECT_URI
```

Do **not** set `SHORTCUT_API_BASE` in production — the default is correct. Until all four secrets are set, `/webhook` and `/oauth/callback` return 503.

### 6. Install the app in your workspace

Install the agent app in the workspace you want guarded — as its builder you can always install it, regardless of review status. Shortcut runs the OAuth flow and redirects to the worker's `/oauth/callback`, which stores the workspace credentials and shows a "Connected!" page.

### 7. Verify

```bash
curl https://<your-worker>.workers.dev/
```

The response is a bare health check. It is unauthenticated, so it deliberately says nothing about which workspaces are connected. `npx wrangler tail` shows `Estimate Guardian OAuth connected` with the workspace and its granted `scopes` when the install completes; credentials saved by older versions report `"unknown"` scopes until OAuth or a refresh returns them. Once you see that line, Estimate Guardian is live — see [Trying it out](#trying-it-out).

API and OAuth requests time out after 15 seconds. `npx wrangler tail` shows bounded, redacted error details with method, endpoint pathname, HTTP status, and provider error tag/message when available. Query strings, callback codes/state, credentials, submitted comment text, and raw errors are not logged by the application. Cloudflare's automatic invocation logs are disabled in `wrangler.toml` so callback URLs are not stored, but an interactive `wrangler tail` can still display them; redact codes and state before sharing a tail.

---

## Local development

Local dev reuses the agent app from step 4. Copy `.dev.vars.example` to `.dev.vars` and fill it in with that app's credentials:

```
CLIENT_ID=<your-agent-app-client-id>
CLIENT_SECRET=<your-agent-app-client-secret>
REDIRECT_URI=http://localhost:8787/oauth/callback
WEBHOOK_SECRET=<your-agent-app-webhook-secret>
```

Then:

```bash
npm install
npx wrangler dev
```

Before deploying changes, run `npm test`, `npx tsc --noEmit`, and `npx wrangler deploy --dry-run` from this directory. Tests cover signature and secret enforcement, body limits, cursor validation, failed lookups, comment-before-revert behavior, warning suppression, actor sanitization, token refresh/scopes, and safe diagnostics.

The worker runs at `http://localhost:8787`. Signatures are always required, including locally: point a tunnel at the worker and let Shortcut deliver real, signed payloads, or sign test bodies yourself with the webhook secret. The agent app's **Redirect URIs** field takes one per line — add `http://localhost:8787/oauth/callback` as a second entry so the local OAuth flow can land.

---

## Trying it out

1. Create a story with no estimate.
2. Drag it into a started state (In Development, or whatever your workflow calls it).
3. It should bounce back within a second or two, with a comment tagging you.
4. Add an Estimate (including **0**), start it again — this time it stays put, and no second comment appears.
