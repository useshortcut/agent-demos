# Guardian

A Cloudflare Worker that enforces one workspace rule: **a story can't be started without a team.**

When a story moves into a started workflow state while its team is empty, Guardian comments on the story tagging whoever moved it, then moves the story back to the state it came from. It does this at most once per story.

> `@ada Stories need a team before being started! Please add a team and start again!`

For background on the platform — payload shapes, trigger semantics, and the app review lifecycle — see [../docs/custom-agents.md](../docs/custom-agents.md).

---

## How it works

Guardian subscribes to **observer** deliveries for the `story` entity type. On each `update` action it:

1. Ignores the delivery if the actor was Guardian itself.
2. Checks the action's `changes`. If neither `workflow_state` nor `team` changed, stops — without calling the API.
3. Re-reads the story. If it has a team, stops.
4. Looks up whether the story's workflow state is of type `started`. If not, stops.
5. Scans the story's comments for a warning it already left. If found, stops.
6. Resolves the actor's `mention_name` and posts the warning comment.
7. Takes the state the story came from out of `changes`, and moves it back.

Steps 3–7 all run off the request path via `waitUntil`, so the webhook returns immediately.

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

That answers two of Guardian's questions from the payload alone. *Did this update touch anything I care about?* — only if there's a `workflow_state` or `team` entry, so the great majority of story updates (edits, comments, estimates, owners) are dropped before any request is made. *Where did the story come from?* — `removes[0].id` of the `workflow_state` entry.

The rest is still re-read, because the delivery is handled asynchronously and describes the story as it *was*, not as it is now:

| Question | Source |
|---|---|
| Does it have a team? | `GET /stories/{id}` → `team` |
| What state is it in? | `GET /stories/{id}` → `workflow_state` (slim — no `type`) |
| Is that state a *started* state? | `GET /workflow-states` → `type`, cached per workspace for an hour |
| Where did it come from? | `changes` → `workflow_state` entry → `removes[0].id` |
| Who moved it? | `GET /members/{actor.member_id}` → `mention_name` |

The `workflow_state` entry is only trusted when its `adds[0].id` matches the story's current state. Otherwise the story has moved again since the delivery was queued, and reverting to that entry's `removes` would send it somewhere it never was.

#### When `changes` is missing

An absent `changes` key means the diff was **unavailable** for that delivery — the payload hit a size limit, or rendering failed for that story — and never that nothing changed. Guardian then does what it did before the field existed: it checks the story regardless of what changed, and reconstructs the previous state from `GET /stories/{id}/history?fields=workflow_state&limit=1`. History entries have the same `attribute` / `adds` / `removes` shape, so the same code reads both, with the same rule about matching `adds` first. The history path also covers a `team` change on a story that was already started, where there is no move in the delivery to read.

### Asking for as little as possible

Every v4 endpoint takes a `fields` query param, and unrequested fields are never calculated — a story rendered whole resolves its description markdown and every nested collection. The first call here runs for *every move or team change in the workspace*, so it matters. One story bouncing looks like this end to end:

```
GET   /stories/123?fields=team,workflow_state
GET   /stories/123/comments?fields=text,author,deleted&limit=100
GET   /members/{actor}?fields=mention_name
POST  /stories/123/comments?fields=id
PATCH /stories/123?fields=id
```

Updates that don't touch the workflow state or team cost nothing; moves and team changes that turn out to be fine cost exactly one two-field story read. Writes ask for `id` alone — just enough to tell success from failure.

List requests follow `next_page_url` cursors, retaining the requested `fields` and omitting `limit` after the first page. Cursor URLs must stay on the same API origin and endpoint. Failed, malformed, incomplete, or looping lists stop processing: Guardian never treats an unavailable comment list as "no warning," nor caches a partial workflow-state list. The versioned state-cache key bypasses potentially partial caches written by earlier releases.

Single-entity API responses are unwrapped from `{ entity: ... }`; list envelopes remain intact for pagination.

Unknown field names are a **400**, not a silently ignored param, so each `*_FIELDS` constant in `src/index.ts` sits directly above the type it fills and the two are meant to be edited together.

### Not reacting to itself

Guardian's own comment and its own revert both come back as fresh observer deliveries. Three things stop the loop:

- **Actor check** — deliveries where `actor.member_id` is Guardian's own member id are dropped immediately.
- **Comment check** — a story that already carries the warning is left alone. This is also what makes the rule fire once per story rather than once per move.
- **State check** — after a revert the story is no longer in a started state, so the next delivery exits at step 4 anyway.

The comment is posted *before* the revert. If commenting fails, the revert is skipped — an unexplained revert would look like the story moving on its own, and with no comment to find, it would repeat on every subsequent update.

### Known gaps

- **Concurrent duplicate deliveries can race the comment check.** Guardian's KV-based, background-processing demo does not serialize deliveries or provide a durable retry queue. A failed lookup leaves the story unchanged and is logged, but the already-acknowledged webhook is not automatically retried.
- **Stories created directly into a started state** are warned but not moved, because there is no previous state to return to. Handling this would mean picking a destination (the workflow's default state, say) rather than restoring one. (Create actions carry no `changes` either way — the diff is on updates only.)
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

```bash
npx wrangler deploy
```

Note the URL wrangler prints — `https://shortcut-guardian-agent.<your-subdomain>.workers.dev`. The next two steps need it. (The worker can't do anything useful yet; its secrets are still missing.)

### 4. Create the agent app in Shortcut

In Shortcut:

1. Click **Agents** in the sidebar.
2. Under **Agents Built By Your Organization**, click **Add an agent**.
3. Fill out the **New Application** form:
   - **Name** and **Mention Handle** — your choice; something like "Guardian". Icon and descriptions are optional.
   - **OAuth Scopes**: **Read**, plus **Create Stories** (Guardian updates stories to move them back) and **Create Comments** (it posts the warning comment).
   - **Redirect URIs**: `https://<your-worker>.workers.dev/oauth/callback`
4. Click **Create Application**, then set the delivery settings on the application:
   - **Webhook URL**: `https://<your-worker>.workers.dev/webhook`
   - **Subscribed entity types**: `story`
   - **Interaction triggers**: none — Guardian is observer-only

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

The response is a bare health check. It is unauthenticated, so it deliberately says nothing about which workspaces are connected. `npx wrangler tail` shows `Guardian OAuth connected` with the workspace and its granted `scopes` when the install completes; credentials saved by older versions report `"unknown"` scopes until OAuth or a refresh returns them. Once you see that line, Guardian is live — see [Trying it out](#trying-it-out).

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

1. Create a story with no team.
2. Drag it into a started state (In Development, or whatever your workflow calls it).
3. It should bounce back within a second or two, with a comment tagging you.
4. Add a team, start it again — this time it stays put, and no second comment appears.
