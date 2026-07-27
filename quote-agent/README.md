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

## Local Development

Copy `.dev.vars.example` to `.dev.vars` and fill in your values:

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

The worker runs at `http://localhost:8787`. In DEV mode, webhook signature verification runs but failures are logged as warnings rather than 401s.

---

## Deployment

### Prerequisites

1. Authenticate Wrangler with your Cloudflare account:
   ```bash
   npx wrangler login
   ```

2. Create a KV namespace for token storage:
   ```bash
   npx wrangler kv namespace create TOKENS
   npx wrangler kv namespace create TOKENS --preview
   ```
   Then update `wrangler.toml` with the IDs printed by those commands.

### Set secrets

Create an agent app in Shortcut Developer Settings and copy the credentials:

```bash
echo "<client-id>"      | npx wrangler secret put CLIENT_ID
echo "<client-secret>"  | npx wrangler secret put CLIENT_SECRET
echo "<webhook-secret>" | npx wrangler secret put WEBHOOK_SECRET
echo "https://<your-worker>.workers.dev/oauth/callback" \
                         | npx wrangler secret put REDIRECT_URI
```

Do **not** set `DEV` or `SHORTCUT_API_BASE` in production — the defaults are correct.

### Deploy

```bash
npx wrangler deploy
```

### After deploying

1. Update the agent app in Shortcut Developer Settings:
   - **Redirect URI**: `https://<your-worker>.workers.dev/oauth/callback`
   - **Webhook URL**: `https://<your-worker>.workers.dev/webhook`

2. Install the agent app in a workspace via the Integrations catalog.

3. Go through the OAuth flow (click **Allow** on the consent page) to generate and store credentials in KV.

---

## Connecting a workspace

After the agent is installed and the OAuth flow is completed, the worker stores credentials in KV keyed by `creds:{workspace_id}`. Check the current state at:

```
GET https://<your-worker>.workers.dev/
```

---

## Quotes

Quotes are loaded from `src/quotes.json` at bundle time. Add or remove quotes there and redeploy.
