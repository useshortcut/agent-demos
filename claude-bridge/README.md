# Claude Bridge

A Cloudflare Worker that joins Shortcut's agent sessions to [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview). When someone assigns the agent a story or epic, @-mentions it, or replies to it, Shortcut opens an agent session. The bridge starts a Managed Agents session for it, shows the agent's progress in the session card, and posts the agent's answer, question, or failure as the turn's outcome. Replies in Shortcut go to the same Managed Agents session.

It is a general agent. What it can do comes from the agent you create in Managed Agents from `agent.json`: its model, system prompt, tools, skills, and MCP servers. The bridge adds nothing to that.

It is a reference demo, not an official integration. It uses one Anthropic API key, one agent, and one environment for every connected workspace, so anyone who can mention it can direct that agent and spend on that key. It serves only the workspaces listed in `ALLOWED_WORKSPACE_IDS`. Shortcut shows an unapproved agent app to every workspace in your organization, so the list is what keeps other workspaces off your key.

**This bridge has not been run against the live Managed Agents API yet.** Its tests run against a mock of the API built from the documentation and the `@anthropic-ai/sdk` type declarations. [Assumptions](#assumptions) lists each place where the bridge relies on behavior the documentation does not state. A first live run should check each one.

For the platform itself (OAuth, webhooks, app review), see [docs/open-agents.md](../docs/open-agents.md).

## What it does

| In Shortcut | In Managed Agents |
|---|---|
| `session.created` (assigned, mentioned, or replied to) | Creates an empty session for `CLAUDE_AGENT_ID` in `CLAUDE_ENVIRONMENT_ID`, then sends the opening request, the story or epic link, and Shortcut's context as its first message. Links it on the card as **Open in Claude Console** when `CLAUDE_CONSOLE_WORKSPACE_ID` is set. |
| The agent is working | Posts the agent's newest message as an ephemeral `thought`. While the agent works without a new message, posts it again every 10 minutes, so Shortcut does not mark the session stale. |
| The agent finished its turn | `response` with the agent's last message |
| The agent called `ask_user` | `elicitation` with the question. The turn is handed back, and the reply goes back as that call's result. Several calls at once are asked one at a time. |
| The session failed, was refused, or waits on something the bridge cannot give | `error` naming the condition |
| A reply (`session.prompted`) | Sends the reply to the same session, or starts a new one if the last one cannot take it |
| Stop | Sends `user.interrupt`, then a `response` "Stopped." on the same turn. **The session stays, and the next reply goes to it.** A reply that was still queued is interrupted too before the stop is answered. |
| Shortcut closes the session | Sends `user.interrupt` and ignores later events, a stop included |

## The agent

`npm run setup` creates the agent from `agent.json`. Edit that file first to change the model, the system prompt, or the tools. Three things matter to the bridge:

- **Keep `ask_user`.** It is a custom tool with one `question` string. A call to it is how the agent hands the turn back with a question. Without it the agent can only finish or fail. The shipped system prompt tells the agent to ask only this way.
- **Give every tool a permission policy that needs no confirmation.** The bridge cannot approve a tool call. `agent.json` sets `always_allow` on the agent toolset. Under `auto` or `always_ask`, a call can wait for a `user.tool_confirmation`. The turn then ends with an error that says so, and the next reply starts a new session, because a session that waits on a confirmation refuses every message.
- **Add no other custom tool.** The bridge runs none. A call to another custom tool ends the turn with an error naming the tool, and the next reply starts a new session.

`setup.mjs` also creates the environment the sessions run in: a cloud container with `limited` networking that can reach package registries and the agent's MCP servers. Edit `ENVIRONMENT` in `setup.mjs` to open more hosts. The web tools are off in `agent.json`. Turning them on under `limited` networking also needs their hosts in `allowed_hosts`.

## How it works

The bridge shares `src/core/` with [Devin Bridge](../devin-bridge). That core holds the Hono app, the Workspace and Session Durable Objects, the state machine, the outbox, the polling cadence, and the failure budgets, and [Devin Bridge's README](../devin-bridge/README.md#how-it-works) describes them. `src/backend.ts` is the adapter: the five calls of the port in `src/core/port.ts`, over `@anthropic-ai/sdk`.

`src/core/` is identical in every bridge. Edit it in any bridge and run `npm run core:sync` there to copy it to the others. `npm test` fails first when the copies differ.

### Where this bridge differs from Devin Bridge

**The session opens empty.** The create carries no `initial_events`, so the session starts idle and does no work. The opening request goes as the first `user.message`. Neither the create nor a message has an idempotency key, and the session list has no metadata filter. A create whose answer was lost therefore leaves an empty idle session behind, and the retry creates another. The empty one costs nothing and is never sent anything. It stays in the Console's session list.

**A stop keeps the session.** `user.interrupt` stops the work and leaves the session able to take the next message. The interrupted turn ends with `stop_reason: end_turn`, like a finished one. The bridge stops polling at a stop, and its next send moves past that idle, so it never reads it as an answer.

An interrupt jumps the queue. It stops the running turn, and a message still queued behind that turn starts the next one. So before each interrupt the bridge reads whether the last event it sent has been taken. While it has not, the halt counts as failed and the core retries it on its backoff, up to 8 attempts over about four minutes. The attempt that finds the message taken interrupts the turn it started, and only then is the stop answered. Two limits remain. If the running turn does not reach a safe boundary within those attempts, the bridge answers "Stopped.", gives the session up, keeps interrupting it for another 8 attempts, and opens a new session for the next reply. And a message whose send the bridge never saw confirmed is not covered, because the bridge does not know its event.

**The link is optional.** The session object does not name its Console workspace, so the bridge builds `https://platform.claude.com/workspaces/{CLAUDE_CONSOLE_WORKSPACE_ID}/sessions/{session id}` only when that variable is set. Use `default` for the Default workspace. Only Developers and Admins of the Anthropic organization can open the link.

### Reading the event list

The adapter keeps a small memo with each session:

- `anchor` is the id of the event the last send created. Everything after it in the event list is the current turn.
- `mark` is the `processed_at` of the newest idle the bridge read that waits on no call. Each poll lists events from there, ascending, so a long session is not read from its start each time. An idle that waits on calls does not move it, so those calls stay in the list until each is answered.
- `asked` is the `ask_user` call whose question the bridge posted and the user has not answered. The next reply goes back as `user.custom_tool_result` for that call, whatever the session's status says at that moment.

Each poll reads `user.message`, `user.custom_tool_result`, `agent.message`, `agent.custom_tool_use`, `session.status_running`, `session.status_idle`, and `session.status_terminated`, in pages of 1,000, up to 10 pages. The last status event after the anchor decides the turn:

| Claude reports | Port status | Shortcut sees |
|---|---|---|
| The anchor is not in the list, or its `processed_at` is null, and the newest status is `session.status_running` | `working`, nothing said | Nothing new. The reply is in line behind the turn before. |
| The anchor is not in the list, or its `processed_at` is null, and the newest status is anything else | `pending` | Nothing new. After 10 minutes, an `error` that says Claude did not pick up the reply, and the session is kept. |
| No status after the anchor, or `session.status_running` | `working` | The newest `agent.message` as a thought |
| `session.status_idle`, `end_turn` | `finished` | `response` |
| `session.status_idle`, `requires_action` on one or more `ask_user` calls | `asked`, user | `elicitation` with the `question` input of the oldest one |
| `session.status_idle`, `requires_action` on another custom tool | `failed`, not kept | `error` naming the tool |
| `session.status_idle`, `requires_action` on anything else (a tool confirmation) | `failed`, not kept | `error` saying the bridge cannot approve |
| `session.status_idle`, `refusal` | `failed`, kept | `error` with the refusal category |
| `session.status_idle`, `retries_exhausted` | `failed`, not kept | `error` |
| `session.status_idle`, any other stop reason | `failed`, kept | `error` naming it |
| `session.status_terminated` anywhere in the list, unless the turn already ended with `end_turn` | `failed`, not kept | `error` |
| A list longer than 10 pages | `failed`, not kept | `error` saying the session has more events than the bridge reads, and one warning in the log |

"Kept" means the next reply goes to the same session. Otherwise the bridge interrupts the session, gives it up, and opens a new one for the next reply.

The pickup clock counts from the send, also for a reply that waited behind a running turn. If a poll lands in the moment between the end of that turn and the start of the next, more than 10 minutes after the send, the turn ends with the pickup error.

**Sends.** The reply to a question the bridge posted is that call's result. A result is processed on receipt, so one that an earlier attempt landed is already in the event list. Before it sends the result, the bridge looks for one with the same call id among the newest 20 and adopts it. The API accepts a second result for a call and it has no effect, so the bridge would otherwise wait for an answer after an event the agent never acted on.

Any other reply is a `user.message`. A session that waits on a call accepts only results, so the bridge first reads the newest 20 status and call events. When the newest status is an idle that waits on an `ask_user` call, the user's message has crossed a question they never saw. It is never sent as the answer. It goes as that call's result with this text, and the question is posted when the agent asks again:

```
The user has not seen this question. They sent this message before it reached them:

<the message>

Ask again if you still need an answer.
```

A message has no idempotency key: a step that dies after the send went through sends the reply twice. Both queue into the same session.

**Halts.** A stop and a retirement both read the newest 20 `user.message` and `user.custom_tool_result` events, then send `user.interrupt`. A 404, 409, or 410 means the session is already gone, and counts as stopped. A start whose create has no answer yet delivered no text, so whatever it made is idle, and the bridge sends it nothing.

## Assumptions

The bridge relies on these where the Managed Agents documentation and the SDK types are silent. Each needs a live run to confirm.

- **Queued messages in the list.** The documentation says a sent `user.message` has a null `processed_at` while it is queued. It does not say whether the event list includes it then. The bridge waits for the anchor to appear with a `processed_at` either way, in a poll and before a stop is answered. One path depends on it: when the bridge never got the answer to its first send, it decides whether the session still needs the introduction by listing `user.message` events. If the list leaves a queued message out, the session is introduced twice.
- **Read-after-write.** The bridge assumes that an event a send created is in the list on the next read. Tool-result adoption depends on it. A result that lands but is not yet listed would be sent again. The API accepts the second one with no effect, and the bridge would read the turn from that event.
- **Ordering.** The list is ordered by `processed_at`. The bridge assumes every event the agent emits in answer to a message has a later `processed_at` than that message, and that a message queued while the agent works gets its `processed_at` when the agent takes it.
- **Terminated sessions.** The bridge assumes the events of a terminated session can still be listed. It lists them to decide whether such a session was ever told anything, when its last send has no answer, and before the interrupt that retires it.
- **The send answer.** `events.send` answers with the created events in `data`, which the SDK types mark optional. The bridge needs the id of the one it sent. An answer without one counts as a transient failure, and the retry sends the message again.
- **Interrupt.** The bridge assumes `user.interrupt` to a session that is gone is answered with 404, 409, or 410, and that no session that still runs answers with one of them. It assumes an interrupt to a session idle on an `ask_user` call leaves the call waiting, so the reply after a stop still answers it.
- **Status events.** The bridge assumes a session that leaves a `requires_action` wait emits `session.status_running`. The newest status event then says whether the session waits on a call, even while the session's queryable status lags.
- **Lookups.** Each lookup reads the newest 20 events of its types. A session with more parallel calls than that is not handled.
- **A question the user never saw.** The bridge assumes the agent asks again after a result that says the user did not see the question. The shipped system prompt does not cover this case.
- **A call made between the lookup and the send.** If the agent calls `ask_user` after the bridge looked for a waiting call and before its `user.message` arrives, the API refuses the message with a 400. The turn ends with an error, and the next reply starts a new session.
- **Stop reasons.** The documentation lists `end_turn`, `requires_action`, `retries_exhausted`, and `budget_reached`. The SDK also has `refusal`. The bridge keeps the session on a refusal and on any reason it does not know.
- **A budget.** The bridge creates sessions without a budget, and the API does not let one be added to such a session. So `budget_reached` cannot occur on a session the bridge created, and it has no mapping of its own.
- **The Workers runtime.** The SDK runs in workerd without `nodejs_compat` for these calls in the runtime smoke. Nothing else of the SDK is exercised there.

## Setup

You will move between a terminal in this directory, Claude Console, and Shortcut's **Agents** page. Agent sessions must be enabled for the Shortcut workspace. Deploy first, because the worker's URL goes into the agent app.

1. Install dependencies and log in to Cloudflare:

   ```bash
   npm install
   npx wrangler login
   ```

2. Deploy. The checked-in `wrangler.toml` creates both Durable Objects. Note the URL wrangler prints:

   ```bash
   npx wrangler deploy
   ```

3. In Claude Console, create an API key in the workspace the sessions should live in. Then create the environment and the agent, once:

   ```bash
   ANTHROPIC_API_KEY=<key> npm run setup
   ```

   It prints `CLAUDE_AGENT_ID=agent_...` and `CLAUDE_ENVIRONMENT_ID=env_...`. Running it again creates another environment and agent.

4. In Shortcut, open **Agents** in the sidebar and click **Add an agent** under **Agents Built By Your Organization**:

   - **Name**: your choice, for example "Claude Bridge". **Handle**: `claude-bridge`.
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
   echo "<workspace-id>"   | npx wrangler secret put ALLOWED_WORKSPACE_IDS
   echo "<key>"            | npx wrangler secret put ANTHROPIC_API_KEY
   echo "<agent_...>"      | npx wrangler secret put CLAUDE_AGENT_ID
   echo "<env_...>"        | npx wrangler secret put CLAUDE_ENVIRONMENT_ID
   ```

   `ALLOWED_WORKSPACE_IDS` is a comma-separated list of the Shortcut workspace ids the bridge serves. If you don't know your workspace's id, set any placeholder, click **Activate** in step 7, and the refusal page shows the id to add. `/oauth/callback` returns 503 until all eight are set. `/webhook` needs all but `ALLOWED_WORKSPACE_IDS`. Leave `SHORTCUT_API_BASE` and `ANTHROPIC_API_BASE` unset in production.

6. Optional: for the **Open in Claude Console** link, add the Console workspace id of the API key to `wrangler.toml` and deploy again. Use `default` for the Default workspace. The id is in the Console's URL bar.

   ```toml
   [vars]
   CLAUDE_CONSOLE_WORKSPACE_ID = "default"
   ```

7. Back on the agent app page, click **Validate** next to the webhook URL. Then click **Activate** under **Activation**, then **Allow** on the consent page. A workspace that is not in `ALLOWED_WORKSPACE_IDS` gets a 403 page naming its id, and nothing is stored.

8. Run `npx wrangler tail` and look for `Claude Bridge connected`. It reports the granted scopes and `sessionsEnabled`.

## Try it

1. @-mention `@claude-bridge` in a comment on a story with a small, concrete request. The session card shows "Starting a Claude session." and then the agent's progress.
2. When the agent asks a question or finishes, reply in the session. The reply goes to the same Managed Agents session.
3. Stop the session from the card while the agent works. The bridge interrupts it and answers "Stopped." Reply again, and the same session takes the reply.

## Local development

Create a separate agent app for local development, with `http://localhost:8787/oauth/callback` as its only redirect URI. Shortcut sends the OAuth flow only to an agent app's first redirect URI, so a second entry on your deployed app is never used. Copy `.dev.vars.example` to `.dev.vars`, fill in that app's credentials with `REDIRECT_URI=http://localhost:8787/oauth/callback` and the Anthropic values, and run `npx wrangler dev`. Signatures are always required, so either point a tunnel at the worker or sign test bodies yourself with `signShortcutWebhookHeaders` from `@shortcut/client/webhooks` and the webhook secret.

Before deploying a change:

```bash
npm test
npx tsc --noEmit
npm run test:runtime
npx wrangler deploy --dry-run
```

`npm test` runs this bridge's tests against a Managed Agents mock in `test/harness.mjs`, the shared `conform` scenarios twice (with and without a Console workspace), and the shared core tests. `test/setup.test.mjs` runs `setup.mjs` against a local mock, never the real API.

## Logging

Shortcut and Claude requests end after 15 seconds, the response body included, and the SDK retries none of them: the core owns retries. A Claude failure is logged as the SDK method, the Managed Agents session id, and the status. The SDK's own logging is off. Response bodies, the API key, OAuth codes and state, prompt text, and the agent's messages are never logged.
