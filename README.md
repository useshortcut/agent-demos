# Shortcut Agent Demos

[![CI](https://github.com/useshortcut/agent-demos/actions/workflows/ci.yml/badge.svg)](https://github.com/useshortcut/agent-demos/actions/workflows/ci.yml)

Reference implementations for [Shortcut Custom Agents](https://shortcut.com) — the platform for building AI agent integrations that live inside a Shortcut workspace.

An agent app is a web service you own. Shortcut sends it signed webhooks when someone assigns it a story, @-mentions it, or replies to one of its comments, and the agent calls back into the Shortcut API to do the work. These demos are small, complete examples of that loop.

## Demos

| Demo | Stack | What it shows |
|---|---|---|
| [`quote-agent`](./quote-agent) | Cloudflare Workers + Hono + Durable Object | The full lifecycle: OAuth install, HMAC webhook verification, token refresh, and threaded comment replies. Posts a random programming quote for each distinct interaction and deduplicates repeated deliveries. |
| [`guardian`](./guardian) | Cloudflare Workers + Hono | Enforcing a workspace rule from observer webhooks. Blocks stories from being started without a team: comments at whoever moved it, then moves it back. Shows how to read *what changed* from an action's `changes` diff, how to fall back to story history when the diff is unavailable, and how to avoid reacting to your own writes. |
| [`team-cop`](./team-cop) | Cloudflare Workers + SQLite Durable Object | Comments at the creator or starter when a Story has no Team. Preserves OAuth scopes, actor logs, durable delivery receipts, and a five-retry cap. Includes the original local Node server. |

## Docs

- [Shortcut Custom Agents overview](./docs/custom-agents.md) — key concepts, webhook payload shapes, interaction triggers, and the app review lifecycle.
- [Shortcut REST API](https://developer.shortcut.com/api/rest/v3) — full API reference.

## Building your own

1. Create an agent app in Shortcut from the **Agents** page in the sidebar (**Add an agent** under **Agents Built By Your Organization**). You'll get a client ID, client secret, and webhook secret.
2. Stand up a service with two public endpoints — an OAuth redirect target and a webhook receiver — and register their URLs on the app.
3. Install the app in a workspace from the integrations catalog and complete the OAuth flow.
4. Verify the `Payload-Signature` header (HMAC-SHA256 over the raw request body) on every delivery before acting on it.

`quote-agent` implements all four steps, including per-interaction delivery coordination; start there.

## Contributing

Each demo is self-contained in its own top-level directory with its own README and dependencies. Keep them small and focused on one idea — the point is to be readable end to end, not to be production-ready.

CI runs each demo's Node tests, applicable TypeScript checks, [local Cloudflare
runtime smoke tests](./runtime-tests/README.md), and a deployment dry run. Run
`npm run test:runtime` inside a demo to exercise its actual Worker/KV/Durable
Object configuration with synthetic credentials and a mock Shortcut API.

## License

[MIT](./LICENSE) — use these as a starting point for your own agents.
