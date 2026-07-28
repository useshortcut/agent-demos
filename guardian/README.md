# Guardian

A Cloudflare Worker that enforces one workspace rule: **a story can't be started without a team.**

When a story moves into a started workflow state while its team is empty, Guardian comments on the story tagging whoever moved it, then moves the story back to the state it came from. It does this at most once per story.

> `@ada Stories need a team before being started! Please add a team and start again!`

For background on the platform — payload shapes, trigger semantics, and the app review lifecycle — see [../docs/open-agents.md](../docs/open-agents.md).

---

## How it works

Guardian subscribes to **observer** deliveries for the `story` entity type. On each `update` action it:

1. Ignores the delivery if the actor was Guardian itself.
2. Re-reads the story. If it has a team, stops.
3. Looks up whether the story's workflow state is of type `started`. If not, stops.
4. Scans the story's comments for a warning it already left. If found, stops.
5. Resolves the actor's `mention_name` and posts the warning comment.
6. Reads story history to find the state the story came from, and moves it back.

Steps 2–6 all run off the request path via `waitUntil`, so the webhook returns immediately.

### Why it re-reads everything

Observer actions tell you *that* a story changed, not *what* changed:

```json
{ "action": "update", "id": 123, "entity_type": "story",
  "global_id": "v2:s:<workspace-id>:123", "uri": "https://app.shortcut.com/..." }
```

There is no diff in the payload, so "did this story just move into a started state, and where from?" has to be reconstructed:

| Question | Source |
|---|---|
| Does it have a team? | `GET /stories/{id}` → `team` |
| What state is it in? | `GET /stories/{id}` → `workflow_state` (slim — no `type`) |
| Is that state a *started* state? | `GET /workflow-states` → `type`, cached per workspace for an hour |
| Where did it come from? | `GET /stories/{id}/history?fields=workflow_state&limit=1` → `removes[0].id` |
| Who moved it? | `GET /members/{actor.member_id}` → `mention_name` |

The history entry is only trusted when its `adds[0].id` matches the story's current state. Otherwise it describes an older move, and reverting to its `removes` would send the story somewhere it never was.

### Not reacting to itself

Guardian's own comment and its own revert both come back as fresh observer deliveries. Three things stop the loop:

- **Actor check** — deliveries where `actor.member_id` is Guardian's own member id are dropped immediately.
- **Comment check** — a story that already carries the warning is left alone. This is also what makes the rule fire once per story rather than once per move.
- **State check** — after a revert the story is no longer in a started state, so the next delivery exits at step 3 anyway.

The comment is posted *before* the revert. If commenting fails, the revert is skipped — an unexplained revert would look like the story moving on its own, and with no comment to find, it would repeat on every subsequent update.

### Known gaps

- **Stories created directly into a started state** are warned but not moved, because there is no previous state to return to. Handling this would mean picking a destination (the workflow's default state, say) rather than restoring one.
- **Deleting the warning comment re-arms the rule.** The comment *is* the record. A KV flag keyed by story id would survive deletion, at the cost of the state being invisible to anyone reading the story.
- **A rename of the marker sentence orphans old warnings**, since matching is on visible text. That's the trade for not putting hidden markup in people's comments.

---

## Configuring the agent app

In Shortcut, under **Settings → Developer**, the agent app needs:

- **Subscribed entity types**: `story`
- **Interaction triggers**: none — Guardian is observer-only
- **Webhook URL**: `https://<your-worker>.workers.dev/webhook`
- **Redirect URI**: `https://<your-worker>.workers.dev/oauth/callback`

The OAuth token needs to be able to read stories, workflow states, members, and history, and to write comments and story updates.

---

## Local development

Copy `.dev.vars.example` to `.dev.vars` and fill it in:

```
CLIENT_ID=<your-agent-app-client-id>
CLIENT_SECRET=<your-agent-app-client-secret>
REDIRECT_URI=http://localhost:8787/oauth/callback
WEBHOOK_SECRET=<your-agent-app-webhook-secret>
DEV=true
```

Then:

```bash
npm install
npx wrangler dev
```

The worker runs at `http://localhost:8787`. With `DEV=true`, signature failures are logged as warnings instead of returning 401.

---

## Deployment

1. Authenticate Wrangler:
   ```bash
   npx wrangler login
   ```

2. Create the KV namespace and put the printed ids into `wrangler.toml`:
   ```bash
   npx wrangler kv namespace create TOKENS
   npx wrangler kv namespace create TOKENS --preview
   ```

3. Push the secrets:
   ```bash
   echo "<client-id>"      | npx wrangler secret put CLIENT_ID
   echo "<client-secret>"  | npx wrangler secret put CLIENT_SECRET
   echo "<webhook-secret>" | npx wrangler secret put WEBHOOK_SECRET
   echo "https://<your-worker>.workers.dev/oauth/callback" \
                            | npx wrangler secret put REDIRECT_URI
   ```

   Do **not** set `DEV` or `SHORTCUT_API_BASE` in production — the defaults are correct.

4. Deploy, install the app in a workspace, and complete the OAuth flow:
   ```bash
   npx wrangler deploy
   ```

`GET /` reports which workspaces have stored credentials.

---

## Trying it out

1. Create a story with no team.
2. Drag it into a started state (In Development, or whatever your workflow calls it).
3. It should bounce back within a second or two, with a comment tagging you.
4. Add a team, start it again — this time it stays put, and no second comment appears.
