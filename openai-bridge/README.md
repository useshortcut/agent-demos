# OpenAI Bridge

A Cloudflare Worker that joins Shortcut's agent sessions to the [OpenAI Agents API](https://developers.openai.com/api/docs/guides/agents-api). When someone assigns the agent a story or epic, @-mentions it, or replies to it, Shortcut opens an agent session. The bridge starts an OpenAI agent session for it, shows the agent's progress in the session card, and posts the agent's answer, question, or failure as the turn's outcome. Replies in Shortcut go back to the same OpenAI session.

**This bridge has not been run against the real Agents API.** Its tests run against a mock built from OpenAI's documentation and the `openai` package's type declarations. [Assumptions](#assumptions-where-the-docs-are-silent) lists every place where it relies on behavior the documentation does not state. A first live run should check each one.

It is a general agent. What the agent can do comes from the saved agent's configuration in OpenAI, which `agent.json` defines, and the bridge adds nothing to it. It uses one OpenAI API key and one saved agent for every connected workspace, so anyone who can mention it can direct that agent and spend on that project. It serves only the workspaces listed in `ALLOWED_WORKSPACE_IDS`. Shortcut shows an unapproved agent app to every workspace in your organization, so the list is what keeps other workspaces off your OpenAI project.

For the platform itself (OAuth, webhooks, app review), see [docs/open-agents.md](../docs/open-agents.md).

## What it does

| In Shortcut | In OpenAI |
|---|---|
| `session.created` (assigned, mentioned, or replied to) | Creates a session from the saved agent with the opening request, the story or epic link, and Shortcut's context as its `input`. The card gets no link, because the Agents API has no page for one session. |
| The agent is working | Posts the agent's newest message as an ephemeral `thought`. While the agent works without a new message, posts it again every 10 minutes, so Shortcut does not mark the session stale. |
| The agent finished | `response` with the agent's last message |
| The agent called `ask_user` | `elicitation` with the question. The turn is handed back, and the reply goes back as the function call's result. |
| The turn failed or was cancelled in OpenAI | `error` naming the condition. The next reply goes to the same session. |
| The session failed, or waits on something the bridge cannot give | `error` naming the condition. The bridge cancels the waiting turn and gives the session up, and the next reply starts a new one. |
| A reply (`session.prompted`) | Sends the reply to the same OpenAI session, or starts a new one if the bridge gave the last one up |
| Stop | Cancels the active turn and, once the session reads `idle`, posts a `response` "Stopped." on the same turn. **The session stays, and the next reply goes to it.** |
| Shortcut closes the session | Cancels the active turn of every session under the conversation's key and ignores later events, a stop included |

The bold row is where this bridge differs from [Devin Bridge](../devin-bridge), where a stop terminates the Devin session and the next reply starts a new one.

## How it works

### Shared core

`src/core/` is the same in every bridge in this repository. It holds the Hono app, the Workspace and Session Durable Objects, the state machine, the Shortcut client, and the backend contract in `src/core/port.ts`. The [Devin Bridge README](../devin-bridge/README.md#how-it-works) describes all of it: the alarm loop and its job order, crash safety, events out of order, the outbox and its idempotency keys, retirement, polling cadence and heartbeats, the pickup timeout, failure budgets and deadlines, and the Shortcut write budget. Those rules hold here unchanged, with OpenAI in place of Devin.

This directory adds two files. `src/agents.ts` calls the Agents API through the `openai` package's typed `client.beta.agents.sessions` resource and reads its answers into a few small types. `src/backend.ts` implements the contract over it. To change `src/core/`, edit it in one bridge and run `npm run core:sync` there, which copies it to the other bridges. `npm test` fails first when the copies differ.

### Opening a session and finding it again

The create carries the opening text as its `input`. It has to, because the Agents API requires `input` when `environment.type` is `none`. With `OPENAI_ENVIRONMENT_TEMPLATE_ID` set, the session runs in an OpenAI-hosted environment built from that template instead.

The create has no idempotency key, so the bridge sets `metadata.shortcut_session` to `shortcut-session-{shortcutSessionId}-{generation}` and lists sessions by that key before it creates one. A retried start adopts the oldest session under the key and retires the rest. It checks the key on each session the list returns, so a server that ignores the filter cannot make it adopt the wrong one. The lookup reads up to 5 pages of 100. If the last page it read says there are more, the lookup fails and the bridge retries the start or the stop, so it never takes part of the sessions for all of them.

The documentation says the metadata filter is eventually consistent. A stop or a close that finds nothing under the key yet looks again twice, 5 and then 10 seconds apart, before it believes the result.

The lag can leave a duplicate. When a create's answer is lost and the filter does not show the session 5 seconds later, the retried start creates a second session. Both are given the opening request, and the bridge follows the second. The first runs that one request with nobody reading it, and no reply is ever sent to it. It runs until its turn ends, or until a stop or a close, which looks the key up again and cancels every session it shows. A duplicate the filter still hides at that moment runs to the end of its turn. The backend contract has no call that hands the core a duplicate found after the open, so nothing looks for one in between.

### Sending a reply

Before a send, the bridge reads the session. The reply goes back as the result of an `ask_user` call, `agent.session.input.tool_result` with `success: true`, only when the bridge showed that call's question on its last read and the session still lists the call. Any other reply goes as an `agent.session.input.message`. To an idle session a message starts a turn. To a working one it steers the active turn.

The session can wait on a question the user has not seen, such as a call that appeared after the bridge's last read, or a second call beside the one just answered. A reply sent then is not that question's answer, so it goes as a message. The next read shows the question as the outcome of the reply's turn, and the reply after that answers it. The agent reads the earlier message when its turn goes on. If the agent answers that message in a later turn of its own, the bridge does not post that answer, because it follows the turn of its last send.

`required_actions` can list several calls in any order, and a call can stay listed after its result was accepted. The bridge shows one unanswered question at a time, answers the call it showed by its id, and remembers the calls it answered for as long as the session lists them, so none is shown or answered twice.

Every send carries an `Idempotency-Key` header with the key the core fixed when it prepared the send. A retried send repeats the key, and the next send has a new one. The API documents the key for messages only. The SDK's own tool dispatcher sends it with function results too, and so does the bridge. Before it resends a function result, the bridge reads the session, and sends nothing when the call is no longer pending.

### Reading the outcome

A send is accepted with a 202 and no body, so nothing the API returns names the input, and right after the send the session still describes the turn before. An accepted message is also not in the session's items until the agent picks it up.

The bridge finds a message by its text. It keeps the text it sent, the item that was newest when the send was prepared, and the texts of earlier messages the items had not shown yet. It reads the items after that item, oldest first. A user message with the text of an earlier send is that send's. The first other one with this send's text is this send's, and its `turn_id` is the turn the bridge follows. Two replies with the same words are told apart by that count. Each read covers up to 1,000 items and the next one goes on where it stopped. An answer to `ask_user` needs no search, because it belongs to the call's turn.

On every poll the bridge reads the session first. Once it knows the turn, it reads that turn's items newest first and stops at the agent's newest complete message, or at its own input, which means the agent has said nothing since. The first match in this table decides:

| OpenAI | Shortcut |
|---|---|
| session `failed` | `error`, and the session is given up |
| session `requires_action` with any function call but `ask_user`, an MCP or computer-use approval request, or an environment connection | `error`, and the session is given up |
| session `requires_action` with an `ask_user` call the bridge has not answered | `elicitation` with the call's `question`, whether or not the agent picked the send up |
| session `requires_action` listing only calls the bridge answered | waiting for the agent to pick the answer up |
| session `in_progress` | working |
| session `idle`, the send's message not in the items yet | waiting for the agent to pick it up |
| session `idle`, the input's turn `completed` | `response` with the agent's last message |
| session `idle`, the input's turn `failed` with `active_turn_not_steerable` | `error` saying OpenAI could not take the reply while it was working |
| session `idle`, the input's turn `failed` with another code | `error` with the code, the session kept |
| session `idle`, the input's turn `cancelled` | `error`, the session kept |
| session `idle`, the input's turn `queued`, `in_progress`, or `waiting` | working |

Waiting for a pickup ends in the core's 10 minute pickup timeout. An idle session alone is never a success, as the documentation warns. The bridge posts only assistant messages that are `completed`, commentary and final answers alike, so a message still being written is posted once it is done. A status the bridge does not recognize counts as working.

### Stop and close

A stop sends `agent.session.input.cancel`, which cancels the active turn and keeps the session and its history. The API's 202 confirms that the cancel was accepted, not that the work stopped, and a 409 says only that the session's state conflicts with the cancel. So after either the bridge reads the session:

- `idle`: the bridge answers "Stopped." and the next reply goes to the same session.
- `failed`, or a 404 on the cancel or the read: the bridge answers "Stopped." and the next reply starts a new session.
- `in_progress` or `requires_action`: the work has not stopped. The bridge tries the stop again, cancel included, after 5, 10, 20, 40, 60, 60, and 60 seconds. After the eighth attempt, about 4 minutes in, the bridge answers "Stopped." anyway and gives the session up. It goes on cancelling that session up to 8 more times in the background and logs a warning if it still works. The next reply starts a new session.

A reply that arrives while a stop is pending waits for the stop.

A stop also looks up the conversation's key and cancels every other session under it in the same way, so a duplicate from a lost create stops too. A close cancels the same sessions, and the bridge then ignores the session.

A session the bridge gives up is cancelled and left in OpenAI. The bridge never deletes a session.

### Failures specific to OpenAI

The `openai` client runs with no retries and a 15 second timeout, so the core's own budgets and deadlines decide every retry. A 429 waits for `Retry-After`. A timeout, a network error, or a 5xx backs off. A 401 or 403 ends the turn and keeps the session. A 404 on the read before a send starts a new session with the reply, like a failed one. Any other 4xx ends the turn and gives the session up. A stop is the exception. Any 4xx but a 404 or a 409 on the cancel ends the stop with "Stopped." and the bridge gives the session up, a 401 or 403 included.

### Assumptions where the docs are silent

- **Metadata filter lag.** The session list's `metadata[key]=value` filter is eventually consistent, and the documentation does not say for how long. A start whose create answer was lost looks the key up again after 5 seconds. If the filter still hides the session then, the bridge creates a second one and both get the opening request. [Opening a session](#opening-a-session-and-finding-it-again) says how long the duplicate runs. Retirement looks a key up at most three times over 15 seconds.
- **A message is saved with the text it was sent.** The API returns nothing that names an accepted message, so the bridge finds its message by comparing texts. If the API changes a text before it saves it, every reply ends in the pickup timeout. The bridge also assumes each accepted message shows up as a user message item with a `turn_id`. If one never shows up, the next reply with the same words is taken for it and ends in the pickup timeout.
- **Two messages in a row.** The documentation says a message to an idle session starts a turn and a message to a working one steers it. It does not say what happens to a message accepted before the agent picked up the one before. The bridge follows the turn that holds its own message, whether that is a new turn or the turn of the earlier message.
- **Steering.** The documentation says of `active_turn_not_steerable` to wait for the active turn to finish, so the bridge expects that turn to go on. It does not say which turn carries the error or whether the refused message is saved. If the message is saved in a failed turn of its own, the Shortcut turn ends with an error once the session is idle. If it is never saved, the reply ends in the pickup timeout.
- **An idle session with no completed turn.** The documentation says an idle session alone does not mean success, without saying when an idle session's turn is still `queued` or `in_progress`. The bridge reads such a turn as working and keeps polling.
- **Item ids and long turns.** Only a legacy user message has a null id, and the sessions this bridge creates have none. A newest item without an id counts as a transient failure. For the agent's last message the bridge reads the newest 1,000 items of the turn, 100 per page. A turn whose last message is older than that, or sits behind an item the bridge cannot read, posts no progress and ends with a plain fallback such as "OpenAI finished."
- **`ask_user` arguments.** The SDK types a call's `arguments` as `unknown`. The bridge reads `arguments.question` from an object or from a JSON string.
- **A function result can be delivered twice.** The reply reaches the agent as the call's result at least once, and once unless a send has to be retried. It happens when the API accepts the result, its answer is lost, and 5 seconds later the session still lists the call, because the agent has not picked the result up. The bridge cannot tell that from a result that never arrived, so it sends the result again with the same `turn_id`, `call_id`, and `Idempotency-Key`. The documentation tells clients to resubmit a saved result with the same ids while the call is pending, and does not say that the API drops the repeat. If it does not, the agent sees the answer twice.
- **Pending calls.** The documentation does not say in what order `required_actions` lists several calls, or when an answered call leaves the list. The bridge relies on neither. It matches calls by `call_id` and treats a call it answered as answered for as long as the session lists it. It does assume that one session never uses a `call_id` for a second call.
- **Cancel.** The documentation does not say how long an accepted cancel takes, or what a cancel answers when no turn is active. The bridge trusts neither answer and reads the session, as [Stop and close](#stop-and-close) describes. If the API answers a cancel with a 4xx other than 404 or 409, the stop still answers "Stopped." and the bridge gives the session up.
- **A stop followed at once by a reply.** The reply waits until the stop is answered, so it is sent only after the session read `idle`, as a message that starts a new turn. A stop during an `ask_user` wait cancels the call, so the reply after it goes as a message too, not as the call's result. The documentation covers none of three orders. If the session reads `idle` before a cancel has taken effect and the cancel then lands on the reply's turn, that turn ends with "The OpenAI turn was cancelled. Reply to try again." If the session keeps working for 4 minutes, the reply waits that long and then opens a new session. If the API still runs a message it accepted before the cancel, the session works again. The bridge cancels again when that happens before it has answered the stop. After "Stopped." that turn runs unseen until it ends.
- **Failure wording.** A failed session's `error` is a free-form message, and the bridge does not post it. It posts a turn's error `code` only when it is lowercase letters and underscores.

## The agent

`agent.json` is the saved agent: its model (`gpt-6-astra`, the model in OpenAI's examples), its instructions, and its tools. It ships one function tool, `ask_user`, with one `question` string. It is how the agent hands the turn back with a question.

- Add tools to `agent.json` and run `npm run setup` again.
- Keep `ask_user`, or the agent can only finish or fail. `npm run setup` warns when it is missing.
- The bridge cannot run any other function, approve an MCP or computer-use request, or connect an environment. A session that waits on one of these ends the turn with an `error` that says so. Give MCP servers approval rules that need no confirmation.

## Setup

Agent sessions must be enabled for the Shortcut workspace (the Agent Sessions platform). Deploy first, because the worker's URL goes into the agent app.

1. Install dependencies and log in to Cloudflare:

   ```bash
   npm install
   npx wrangler login
   ```

2. Deploy. The checked-in `wrangler.toml` creates both Durable Objects. Note the URL wrangler prints:

   ```bash
   npx wrangler deploy
   ```

3. In the OpenAI platform, create an API key for the project that should hold the agent. Then save the agent from `agent.json` and note the id it prints:

   ```bash
   OPENAI_API_KEY=<key> npm run setup
   #   OPENAI_AGENT_ID=agent_...
   ```

   To change the agent later, edit `agent.json` and run `OPENAI_API_KEY=<key> OPENAI_AGENT_ID=<id> npm run setup`, which updates it. Updates apply to new sessions only. `npm run setup -- --dry-run` prints the request and sends nothing.

4. In Shortcut, open **Agents** in the sidebar and click **Add an agent** under **Agents Built By Your Organization**:

   - **Name**: your choice, for example "OpenAI Bridge". **Handle**: `openai-bridge`.
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
   echo "<key>"            | npx wrangler secret put OPENAI_API_KEY
   echo "<agent_...>"      | npx wrangler secret put OPENAI_AGENT_ID
   ```

   `ALLOWED_WORKSPACE_IDS` is a comma-separated list of the Shortcut workspace ids the bridge serves. If you don't know your workspace's id, set any placeholder, click **Activate** in step 7, and the refusal page shows the id to add. `/oauth/callback` returns 503 until all seven are set. `/webhook` needs all but `ALLOWED_WORKSPACE_IDS`. An unset or empty list allows no workspace, but a stop still reaches a session the bridge knows, so clearing the list keeps cleanup working. Leave `SHORTCUT_API_BASE` and `OPENAI_API_BASE` unset in production.

6. Optional: to run sessions in an OpenAI-hosted environment, set `OPENAI_ENVIRONMENT_TEMPLATE_ID` under `[vars]` in `wrangler.toml` to an environment template id and deploy again. Unset, sessions run with `environment: { type: "none" }`.

7. Back on the agent app page, click **Validate** next to the webhook URL. Then click **Activate** under **Activation**, then **Allow** on the consent page. A workspace that is not in `ALLOWED_WORKSPACE_IDS` gets a 403 page naming its id, and nothing is stored. Otherwise the worker stores the credentials and turns on agent sessions for the installation. If that second step fails, the page says so with a 502. Click **Activate** again to retry.

8. Run `npx wrangler tail` and look for `OpenAI Bridge connected`. It reports the granted scopes and `sessionsEnabled`. `GET /` is a bare health check and says nothing about connected workspaces.

## Try it

1. @-mention `@openai-bridge` in a comment on a story with a small, concrete request. The session card shows "Starting an OpenAI session." and then the agent's progress.
2. When the agent asks a question or finishes, reply in the session. The reply goes to the same OpenAI session.
3. Stop the session from the card. The bridge cancels the turn and answers "Stopped." Reply again, and the same session picks the conversation up.

To see what the agent did, open [Logs, Agents](https://platform.openai.com/logs?api=agents) in the OpenAI platform and select the agent's project. Each session the bridge created carries the Shortcut session id in its `shortcut_session` metadata.

## Local development

Copy `.dev.vars.example` to `.dev.vars`, fill in the agent app's credentials with `REDIRECT_URI=http://localhost:8787/oauth/callback`, your OpenAI key, and the agent id, and run `npx wrangler dev`. Add that redirect URI to the agent app as a second entry. Signatures are always required, so either point a tunnel at the worker or sign test bodies yourself with `signShortcutWebhookHeaders` from `@shortcut/client/webhooks` and the webhook secret.

Before deploying a change:

```bash
npm test
npx tsc --noEmit
npm run test:runtime
npx wrangler deploy --dry-run
```

`npm test` runs the drift check, this bridge's tests (including the shared `conform` scenarios), and the core tests in `runtime-tests/bridge/`. The `openai` package adds about 1 MB to the Worker bundle.

## Logging

Shortcut and OpenAI requests time out after 15 seconds. A Shortcut failure is logged as its method, endpoint path, status, and a provider error code when there is one. An OpenAI failure is logged as the SDK call's name, such as `sessions.events.create`, and its status. The `openai` client's own logging is off. `npm run setup` prints a failed request as its name and status, such as `agents.create failed with HTTP 400.` Response bodies, query strings, tokens, the OpenAI key, OAuth codes and state, prompt text, and the agent's messages are never logged. Cloudflare's automatic invocation logs are off, but an interactive `wrangler tail` can still show callback URLs, so redact codes and state before sharing one.
