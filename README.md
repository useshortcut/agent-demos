# Shortcut Agent Demos

[![CI](https://github.com/useshortcut/agent-demos/actions/workflows/ci.yml/badge.svg)](https://github.com/useshortcut/agent-demos/actions/workflows/ci.yml)

Reference implementations for [Shortcut Custom Agents](https://shortcut.com), the platform for building agents that live inside a Shortcut workspace.

An agent is a web service you own. Shortcut sends it signed webhooks when something happens in the workspace, or when someone assigns it a story, @-mentions it, or replies to one of its comments. The agent calls back into the Shortcut API to do its work. These demos are small, complete examples of that loop.

## Demos

| Demo | Stack | What it shows |
|---|---|---|
| [Quote Agent](./quote-agent) | Workers, Hono, Durable Object | The interaction lifecycle: install, verified webhooks, threaded replies, and deduplicated deliveries. Posts a random quote when assigned, mentioned, or replied to. |
| [Estimate Guardian](./estimate-guardian) | Workers, Hono, Durable Object | Enforcing a rule from observer webhooks. Bounces stories started without an estimate, using the action's `changes` diff and durable recovery. |
| [Team Cop](./team-cop) | Workers, SQLite Durable Object | The same observer pattern in plain JavaScript. Comments when a story is created or started without a Team, with durable retries. |

## Docs

- [Custom Agents overview](./docs/custom-agents.md): concepts, payload shapes, interaction triggers, and the app review lifecycle.
- [`@shortcut/client`](https://github.com/useshortcut/shortcut-client-js): the official JavaScript client. `@shortcut/client/v4` covers the API, the agent OAuth flow, and token refresh; `@shortcut/client/webhooks` verifies deliveries and types their payloads. All three demos use it.
- [Shortcut REST API](https://developer.shortcut.com/api/rest/v3): the full API reference.

## Building your own

1. Create an agent app in Shortcut from the **Agents** page (**Add an agent** under **Agents Built By Your Organization**). You get a client id, a client secret, and a webhook secret.
2. Stand up a service with two public endpoints, an OAuth redirect target and a webhook receiver, and register their URLs on the app.
3. Activate the app in your workspace from the **Activation** section of its page and complete the OAuth flow.
4. Verify the `Payload-Signature` header on every delivery before acting on it.

`@shortcut/client` does the mechanical parts of steps 2 to 4: `ShortcutOAuth` completes the install and refreshes tokens, `ShortcutV4Client` calls the API and walks cursor-paged lists, and `ShortcutWebhookClient` verifies and parses each delivery. What is left for your service is storing credentials and the rule itself.

Quote Agent implements all four steps. Start there.

## Contributing

Each demo is self-contained in its own directory with its own README and dependencies. Keep them small and focused on one idea; the goal is to be readable end to end, not production-ready.

CI runs each demo's tests, its TypeScript check where it has one, the [local Cloudflare runtime smoke tests](./runtime-tests/README.md), and a deploy dry run. Run `npm run test:runtime` inside a demo to exercise its real Worker configuration against a mock Shortcut API.

## License

[MIT](./LICENSE). Use these as a starting point for your own agents.
