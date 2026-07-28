# Open Agents in Shortcut

Open Agents is a platform that lets developers create, publish, and install first-class AI agent integrations in Shortcut. Unlike the built-in agents, user-created agent apps are self-serve: builders configure them in Developer Settings and workspace admins install them from the integrations catalog.

## Key Concepts

**Agent Application** — A globally-registered agent. Stores credentials, webhook URL, icon, mention handle, subscribed entity types, and interaction triggers. Created from Settings → Developer.

**Installation** — A per-workspace record linking an agent app to a workspace. On install, the agent gets its own member identity, so it can be @-mentioned, assigned stories, and post comments.

**Observer Delivery** — Every change in a workspace fans out a v2 webhook payload to all active agent installations in that workspace, filtered to the entity types each agent subscribed to.

**Interaction-Triggered Delivery** — Fires when a user explicitly addresses an agent: assigns it, @-mentions it, or replies to one of its comments.

**Webhook Signing** — All deliveries are signed with HMAC-SHA256 using a per-app secret. The hex digest is sent in the `Payload-Signature` request header.

## Payload Shapes

### Observer (v2 envelope)

```json
{
  "id": "<audit-key-uuid>",
  "version": "v2",
  "timestamp": "<iso8601ms>",
  "actor": {
    "displayable_name": "Ada",
    "member_id": "<permission-uuid>"
  },
  "workspace2": { "id": "<uuid>", "url_slug": "my-workspace" },
  "installation_id": "<uuid>",
  "actions": [
    {
      "action": "create | update | delete",
      "id": 123,
      "entity_type": "story",
      "global_id": "v2:s:<workspace-id>:123",
      "uri": "https://app.shortcut.com/my-workspace/story/123"
    }
  ]
}
```

### Interaction (same envelope, `trigger` instead of `actions`)

```json
{
  "id": "<audit-key-uuid>",
  "version": "v2",
  "timestamp": "<iso8601ms>",
  "actor": { "displayable_name": "Ada", "member_id": "<uuid>" },
  "workspace2": { "id": "<uuid>", "url_slug": "my-workspace" },
  "installation_id": "<uuid>",
  "trigger": {
    "type": "assigned | comment-reply | mentioned",
    "entity_type": "story | epic",
    "entity_id": "123"
  }
}
```

Per-trigger fields:

| Trigger | Additional fields |
|---|---|
| `assigned` | — |
| `comment-reply` | `comment_id`, `parent_comment_id` |
| `mentioned` | `context` (`comment` or `description`), and when `context` is `comment`: `comment_id`, `comment_parent_id` |

## Interaction Triggers

| Trigger | When |
|---|---|
| `assigned` | Agent added as owner of a story or epic |
| `comment-reply` | User replies to a comment authored by the agent |
| `mentioned` | Agent @-mentioned in a comment or story/epic description |

## Review Lifecycle

| Status | Meaning |
|---|---|
| `draft` | Created, not yet submitted for review |
| `submitted` | Developer submitted for Shortcut staff approval |
| `approved` | Visible in the global catalog for all workspaces |
| `withdrawn` | Developer withdrew submission (can resubmit) |

Builders can always install their own apps regardless of review status. Disabled apps are excluded from all deliveries.

## Working With Observer Deliveries

### Actions carry no diff

An action says *that* an entity changed, not *what* changed — there are no before/after values and no list of touched fields. An agent that needs the difference has to reconstruct it:

- **Current values** — re-read the entity, e.g. `GET /api/v4/{slug}/stories/{id}`.
- **Previous values** — ask story history, e.g. `GET /api/v4/{slug}/stories/{id}/history?fields=workflow_state&limit=1`. Each change entry has `adds` and `removes`. Confirm the entry's `adds` matches the entity's current value before trusting its `removes`, or you may be reading an older change.
- **Nested references are slim** — a story's `workflow_state` has an id and a name but no `type`. Fetching `GET /api/v4/{slug}/workflow-states` gives the `type` (`unstarted`, `started`, `done`) for each state; it changes rarely and caches well.

### Avoiding feedback loops

An agent subscribed to observer deliveries will also see the changes it makes itself. Filter on `actor.member_id` against the agent's own member id (returned as `permission_id` in the OAuth token response) before acting on a delivery — otherwise a comment the agent posts triggers a delivery that prompts another comment.

For anything that both reads and writes, the actor check alone is thin. Pair it with a check of the durable effect — "have I already commented on this story?" — so a restart, a missed id, or a manual retry can't produce a second round of writes.

See [`guardian`](../guardian) for a worked example of both, and [`quote-agent`](../quote-agent) for one that only responds to interaction triggers.
