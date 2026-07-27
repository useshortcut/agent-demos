# Shortcut Agent Demos

Reference implementations for [Shortcut](https://shortcut.com) Open Agents — the platform for building AI agent integrations that live inside a Shortcut workspace.

An agent app is a web service you own. Shortcut sends it signed webhooks when someone assigns it a story, @-mentions it, or replies to one of its comments, and the agent calls back into the Shortcut API to do the work. These demos are small, complete examples of that loop.

## Demos

| Demo | Stack | What it shows |
|---|---|---|
| [`quote-agent`](./quote-agent) | Cloudflare Workers + Hono | The full lifecycle: OAuth install, HMAC webhook verification, token refresh, and threaded comment replies. Posts a random programming quote whenever it's assigned or mentioned. |

## Docs

- [Open Agents overview](./docs/open-agents.md) — key concepts, webhook payload shapes, interaction triggers, and the app review lifecycle.
- [Shortcut REST API](https://developer.shortcut.com/api/rest/v3) — full API reference.

## Building your own

1. Create an agent app in Shortcut under **Settings → Developer**. You'll get a client ID, client secret, and webhook secret.
2. Stand up a service with two public endpoints — an OAuth redirect target and a webhook receiver — and register their URLs on the app.
3. Install the app in a workspace from the integrations catalog and complete the OAuth flow.
4. Verify the `Payload-Signature` header (HMAC-SHA256 over the raw request body) on every delivery before acting on it.

`quote-agent` implements all four steps in about 450 lines; start there.

## Contributing

Each demo is self-contained in its own top-level directory with its own README and dependencies. Keep them small and focused on one idea — the point is to be readable end to end, not to be production-ready.
