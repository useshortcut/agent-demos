# Shortcut Quote Agent Service

A toy Cloudflare Worker that demonstrates the Open Agents platform. When installed in a Shortcut workspace it responds to interaction triggers (assigned, @-mentioned, comment-reply) by posting a random quote as a comment on the relevant story or epic.

It also tracks observer webhook deliveries (entity create/update/delete counts by type) and exposes them at `/stats`.

For background on the platform itself — payload shapes, trigger semantics, and the app review lifecycle — see [../docs/open-agents.md](../docs/open-agents.md).

---

## Architecture

- **Runtime**: Cloudflare Workers (Hono framework)
- **Storage**: Cloudflare KV (`TOKENS` namespace) — stores OAuth credentials and action stats per workspace
- **Auth**: OAuth 2.0 authorization code flow with the Shortcut v4 API
- **Webhooks**: Receives signed HMAC-SHA256 payloads from Shortcut

### Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Health check + KV credential summary |
| `GET` | `/oauth/callback` | OAuth redirect target — exchanges code for token, stores credentials |
| `POST` | `/webhook` | Receives Shortcut interaction and observer webhooks |
| `GET` | `/stats` | Plain-text observer delivery stats per workspace |

### Trigger handling

| Trigger | Behaviour |
|---|---|
| `assigned` | Posts a quote on the assigned story/epic |
| `comment-reply` | Replies in the same thread (under the original agent comment) |
| `mentioned` in a top-level comment | Replies nested under that comment |
| `mentioned` in a nested comment | Replies under the thread root (max depth 1) |
| Observer delivery | Records action counts in KV, no comment posted |

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
   - **Subscribed entity types**: optional — observer deliveries only feed the `/stats` page. Subscribe to `story` and `epic` if you want them counted.

Creating the app gives you its **client id**, **client secret**, and **webhook secret** — keep them at hand for the next step.

### 5. Push the secrets

```bash
echo "<client-id>"      | npx wrangler secret put CLIENT_ID
echo "<client-secret>"  | npx wrangler secret put CLIENT_SECRET
echo "<webhook-secret>" | npx wrangler secret put WEBHOOK_SECRET
echo "https://<your-worker>.workers.dev/oauth/callback" \
                         | npx wrangler secret put REDIRECT_URI
```

Do **not** set `DEV` or `SHORTCUT_API_BASE` in production — the defaults are correct.

### 6. Install the app in your workspace

Install the agent app in a workspace — as its builder you can always install it, regardless of review status. Shortcut runs the OAuth flow (click **Allow** on the consent page) and redirects to the worker's `/oauth/callback`, which stores the workspace credentials in KV keyed by `creds:{workspace_id}`.

### 7. Verify

```bash
curl https://<your-worker>.workers.dev/
```

The response lists each workspace with stored credentials. If yours is there, the agent is live.

---

## Trying it out

1. @-mention the agent in a comment on a story — it replies in-thread with a quote.
2. Assign it a story or epic — it posts a quote as a comment.
3. Check `https://<your-worker>.workers.dev/stats` for observer delivery counts.

---

## Local development

Local dev reuses the agent app from step 4. Copy `.dev.vars.example` to `.dev.vars` and fill it in with that app's credentials:

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

The worker runs at `http://localhost:8787`. With `DEV=true`, webhook signature verification runs but failures are logged as warnings rather than 401s. The agent app's **Redirect URIs** field takes one per line — add `http://localhost:8787/oauth/callback` as a second entry so the local OAuth flow can land.

---

## Quotes

Quotes are loaded from `src/quotes.json` at bundle time. Add or remove quotes there and redeploy.
