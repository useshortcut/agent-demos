# Shortcut Quote Agent Service

A toy Cloudflare Worker that demonstrates the Shortcut Custom Agents platform. When installed in a Shortcut workspace it responds to interaction triggers (assigned, @-mentioned, comment-reply) by posting a random quote as a comment on the relevant story or epic.

For background on the platform itself — payload shapes, trigger semantics, and the app review lifecycle — see [../docs/custom-agents.md](../docs/custom-agents.md).

---

## Architecture

- **Runtime**: Cloudflare Workers (Hono framework)
- **Storage**: Cloudflare KV (`TOKENS` namespace) — stores OAuth credentials per workspace
- **Delivery coordination**: SQLite Durable Object (`QUOTE_DELIVERIES`) — serializes interactions per workspace and stores completed-delivery receipts
- **Auth**: OAuth 2.0 authorization code flow with the Shortcut v4 API
- **Webhooks**: Receives signed HMAC-SHA256 payloads from Shortcut

### Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Health check (unauthenticated, so it lists no workspaces) |
| `GET` | `/oauth/callback` | OAuth redirect target — exchanges code for token, stores credentials |
| `POST` | `/webhook` | Receives Shortcut interaction webhooks; observer deliveries are acknowledged and ignored |

### Trigger handling

| Trigger | Behaviour |
|---|---|
| `assigned` | Posts a quote on the assigned story/epic |
| `comment-reply` | Replies in the same thread (under the original agent comment) |
| `mentioned` in a top-level comment | Replies nested under that comment |
| `mentioned` in a nested comment | Replies under the thread root (max depth 1) |
| Observer delivery | Records action counts and changed attributes in KV, no comment posted |

Each interaction is identified by its installation, workspace, and delivery ID.
Redelivery of that interaction does not post again; a new mention, assignment, or
reply still gets a new quote, even on the same Story or Epic. The coordinator
serializes concurrent interactions, including token refresh. Before posting, it
scans current comments for a matching `external_id` authored by this agent. This
recovers a successful POST if execution stopped before its receipt was saved.
The API comment lists include threaded replies, so this works for replies too.
Cursor pages stay on the same API origin and resource; malformed, incomplete,
or failed scans abort processing instead of being treated as an empty list.

Failures return HTTP 503 without storing a receipt. This demo does not enqueue
its own retries or guarantee that Shortcut redelivers failures. It also cannot
guarantee exactly-once external writes if a timed-out POST is still in flight
when another attempt checks comments. Completed receipts currently have no
retention cleanup; adapt this reference implementation for sustained traffic.

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

Note the URL wrangler prints — `https://shortcut-agent-service.<your-subdomain>.workers.dev`. The next two steps need it. (The worker can't do anything useful yet; its secrets are still missing.)

Wrangler creates the SQLite Durable Object class using the included `v1`
migration. Keep the `TOKENS` namespace IDs unchanged when upgrading an existing
deployment; OAuth credentials remain in KV, so this change does not require
reauthorization. Existing interactions processed by the old version have no
receipt or per-delivery comment marker and cannot be retroactively deduplicated.

### 4. Create the agent app in Shortcut

In Shortcut:

1. Click **Agents** in the sidebar.
2. Under **Agents Built By Your Organization**, click **Add an agent**.
3. Fill out the **New Application** form:
   - **Name** and **Mention Handle** — your choice; something like "Wise Bot". Icon and descriptions are optional.
   - **OAuth Scopes**: **Read** and **Write** — the agent comments on both stories and epics, and the narrower **Create Comments** scope only covers story comments.
   - **Redirect URIs**: `https://<your-worker>.workers.dev/oauth/callback`
4. Click **Create Application**, then set the delivery settings on the application:
   - **Webhook URL**: `https://<your-worker>.workers.dev/webhook`
   - **Interaction triggers**: `assigned`, `comment-reply`, and `mentioned` — these are what make the agent respond.
   - **Subscribed entity types**: none needed — this agent only acts on interaction triggers and ignores observer deliveries.

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

Install the agent app in a workspace — as its builder you can always install it, regardless of review status. Shortcut runs the OAuth flow (click **Allow** on the consent page) and redirects to the worker's `/oauth/callback`, which stores the workspace credentials in KV keyed by `creds:{workspace_id}`.

### 7. Verify

```bash
curl https://<your-worker>.workers.dev/
```

The response is a bare health check. It is unauthenticated, so it deliberately
says nothing about which workspaces are connected. `npx wrangler tail` shows
`Quote Agent connected` with the workspace and its scopes when the install
completes; once you see that line, the agent is live.

Scopes are logged on connection and refresh. Older stored credentials report
`unknown` until a token response supplies scopes; a refresh without a scope
field preserves previously known scopes. All Shortcut requests use a 15-second timeout. Request error logs include
method, pathname, status, and bounded API error codes (`tag`, `error`, `code`).
Free-form error messages/descriptions and response bodies are intentionally
omitted because they can echo user content or credentials. OAuth state, codes,
tokens, and query strings are not application-logged. Automatic invocation logs
are disabled to avoid storing callback URLs, but interactive `wrangler tail`
can still display those URLs: redact codes and state before sharing a tail.

---

## Trying it out

1. @-mention the agent in a comment on a story — it replies in-thread with a quote.
2. Assign it a story or epic — it posts a quote as a comment.

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

The worker runs at `http://localhost:8787`. Signatures are always required, including locally: point a tunnel at the worker and let Shortcut deliver real, signed payloads, or sign test bodies yourself with the webhook secret. The agent app's **Redirect URIs** field takes one per line — add `http://localhost:8787/oauth/callback` as a second entry so the local OAuth flow can land.

Run checks from this directory:

```bash
npm test
npx tsc --noEmit
npx wrangler deploy --dry-run
```

---

## Quotes

Quotes are loaded from `src/quotes.json` at bundle time. Add or remove quotes there and redeploy.
