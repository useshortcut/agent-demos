# Open Agents in Shortcut

Open Agents is a platform that lets developers create, publish, and install first-class AI agent integrations in Shortcut. Unlike the built-in agents, user-created agent apps are self-serve: builders configure them from the Agents page in the sidebar and workspace admins install them from the integrations catalog.

## Key Concepts

**Agent Application** — A globally-registered agent. Stores credentials, webhook URL, icon, mention handle, subscribed entity types, and interaction triggers. Created from the **Agents** page in the sidebar (**Add an agent** under **Agents Built By Your Organization**).

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
      "app_url": "https://app.shortcut.com/my-workspace/story/123",
      "uri": "https://app.shortcut.com/my-workspace/story/123",
      "changes": [
        {
          "attribute": "workflow_state",
          "adds": [{ "entity_type": "workflow-state:slim", "id": 500000002, "name": "In Progress", "workflow_name": "Standard", "uri": "..." }],
          "removes": [{ "entity_type": "workflow-state:slim", "id": 500000001, "name": "To Do", "workflow_name": "Standard", "uri": "..." }]
        },
        { "attribute": "estimate", "adds": [8], "removes": [5] }
      ]
    }
  ]
}
```

Action fields:

- **`app_url`** — the entity's URL in the Shortcut app, the same value the REST API returns as `app_url`. Can be `null` when no URL could be built.
- **`uri`** is **deprecated** — read `app_url` instead. Its value and entity-type coverage are frozen for legacy consumers; entity types added since (labels, for instance) get `app_url` only.
- **`changes`** — the diff, on **update actions only** and currently for **stories** only. See [Reading what changed](#reading-what-changed) below for the three states it can be in and what each means.
- **`changes` format** — the same as the v4 story history API's change entries: `attribute`, `adds`, `removes`, with slim entities for references and plain scalars otherwise (instants as ISO-8601). A cardinality-one replacement is `adds: [new], removes: [old]`; setting a previously-unset attribute has `removes: []`; clearing one has `adds: []`. Exception: `blocked` and `blocker` render `false` when unset, so first-time blocking reports `adds: [true], removes: [false]`.
- **Tracked attributes** — `workflow_state`, `owners`, `epic`, `iterations`, `labels`, `project`, `team`, `estimate`, `story_type`, `deadline`, `started`, `completed`, `archived`, `name`, `description`, `blocked`, `blocker`, `requester`, `followers`, `branches`, `commits`. `custom_field_values` and everything else (comments, tasks, parent story, position, …) are not reported.
- **Size limits** — string values longer than 8,192 characters (in practice, `description`) are cut and the entry carries `"truncated": true`; fetch the story for the full after-value or story history for the before-value. A transaction that touches more than 100 stories only through references (deleting a project with hundreds of stories, say) emits no actions for those indirectly-touched stories. If a delivery's actions would exceed about 1 MB, it is sent without `changes` at all.

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

### Reading what changed

A story `update` action carries a `changes` list describing the transaction's diff. It has three states, and the difference between the last two matters:

| `changes` | Meaning |
|---|---|
| Non-empty list | These tracked attributes changed, with before (`removes`) and after (`adds`) values. |
| `[]` | The update touched nothing that is tracked — a comment, a task, a custom field. |
| Key absent | **Unavailable**, not unchanged. The entity type isn't covered yet, or the delivery degraded (a size limit, or a rendering failure for that story). |

Two habits follow from that:

- **Filter on `changes` before calling the API.** An agent that only cares about, say, `workflow_state` and `team` can drop every other update without a request. When the key is absent, assume anything could have changed and fall through to the slow path.
- **Trust an entry's `removes` only after matching its `adds`.** Deliveries are handled asynchronously, so by the time an agent re-reads the story it may have moved again. If `adds[0].id` isn't the story's current value, the entry describes an older change and reverting to its `removes` would send the story somewhere it never was.

Actions for other entity types, and story updates whose `changes` key is absent, say *that* an entity changed but not *what*. An agent that still needs the difference reconstructs it:

- **Current values** — re-read the entity, e.g. `GET /api/v4/{slug}/stories/{id}`.
- **Previous values** — ask story history, e.g. `GET /api/v4/{slug}/stories/{id}/history?fields=workflow_state&limit=1`. History entries have the same `attribute` / `adds` / `removes` shape as `changes`, so one code path can read both — with the same rule about matching `adds` first.
- **Nested references are slim** — a `workflow_state` in either source has an id and a name but no `type`. Fetching `GET /api/v4/{slug}/workflow-states` gives the `type` (`unstarted`, `started`, `done`) for each state; it changes rarely and caches well.

### Avoiding feedback loops

An agent subscribed to observer deliveries will also see the changes it makes itself. Filter on `actor.member_id` against the agent's own member id (returned as `permission_id` in the OAuth token response) before acting on a delivery — otherwise a comment the agent posts triggers a delivery that prompts another comment.

For anything that both reads and writes, the actor check alone is thin. Pair it with a check of the durable effect — "have I already commented on this story?" — so a restart, a missed id, or a manual retry can't produce a second round of writes.

See [`guardian`](../guardian) for a worked example of both, and [`quote-agent`](../quote-agent) for one that only responds to interaction triggers.
