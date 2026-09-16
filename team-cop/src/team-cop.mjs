import { verifyShortcutWebhookSignature } from "@shortcut/client/webhooks";

export const REMINDER_TEXT = "Stories need to be in a Team! Please add one!";

export function reminderReason(action) {
  if (action?.entity_type !== "story") return null;
  if (action.action === "create") return "created";
  if (action.action !== "update" || !Array.isArray(action.changes)) return null;

  const startedChange = action.changes.find((change) => change?.attribute === "started");
  return startedChange?.adds?.includes(true) ? "started" : null;
}

// `addressee` is either a resolved `@mention_name` or a sanitized display name.
// Only the former is prefixed with "@": a display name must never turn into a
// mention of whoever happens to have that mention name.
export function buildReminder(addressee) {
  return `${addressee} ${REMINDER_TEXT}`;
}

// The display name comes straight from the delivery and ends up in a comment
// Team Cop authors, so it is reduced to plain words before use: no markdown,
// no @-mentions of someone else, no runaway length.
export function safeDisplayName(name) {
  const cleaned = typeof name === "string"
    ? name.replace(/[^\p{L}\p{N}.'_-]+/gu, " ").trim().slice(0, 80)
    : "";
  return cleaned || null;
}

// Constant-time HMAC-SHA256 over the exact request bytes (WebCrypto). A copy
// keeps a pooled Buffer's neighbours out of the digest.
export function verifyWebhookSignature(rawBody, signature, secret) {
  const bytes = typeof rawBody === "string" ? rawBody : new Uint8Array(rawBody);
  return verifyShortcutWebhookSignature(secret, bytes, signature);
}

function processedKey(payload, action, reason) {
  return [
    payload.installation_id ?? "unknown-installation",
    payload.id,
    action.entity_type,
    action.id,
    reason,
  ].join(":");
}

export function createTeamCopProcessor({ client, logger = console, state }) {
  return async function processObserverPayload(payload) {
    if (!payload?.workspace2?.id || !Array.isArray(payload.actions)) return;

    const workspaceId = payload.workspace2.id;
    const credentials = await state.getWorkspace(workspaceId);
    if (!credentials) {
      throw new Error(
        `No OAuth credentials for workspace ${workspaceId}. Enable Team Cop and complete OAuth first.`,
      );
    }

    const actor = payload.actor;
    if (actor?.member_id && actor.member_id === credentials.memberId) {
      logger.info("Ignoring Team Cop's own delivery", { deliveryId: payload.id, workspaceId });
      return;
    }

    for (const action of payload.actions) {
      const reason = reminderReason(action);
      if (!reason) continue;

      const key = processedKey(payload, action, reason);
      if (await state.hasProcessed(key)) continue;

      const story = await client.getStory(workspaceId, credentials, action.id);
      if (story.team) {
        logger.info("Story event has a Team; no reminder needed", {
          actor: {
            displayableName: actor?.displayable_name ?? "Unknown",
            memberId: actor?.member_id ?? null,
          },
          deliveryId: payload.id,
          reason,
          storyId: action.id,
          teamId: story.team.id ?? null,
          teamName: story.team.name ?? null,
          workspaceId,
        });
        await state.markProcessed(key);
        continue;
      }

      if (!actor?.member_id) {
        logger.warn("Cannot address reminder because the webhook actor has no member_id", {
          deliveryId: payload.id,
          reason,
          storyId: action.id,
          workspaceId,
        });
        await state.markProcessed(key);
        continue;
      }

      // The delivery carries the member's handle, so no lookup is needed.
      const addressee = actor.mention_name ? `@${actor.mention_name}` : safeDisplayName(actor.displayable_name);
      if (!addressee) {
        logger.warn("Cannot address reminder because the actor has no mention name", {
          actorMemberId: actor.member_id,
          deliveryId: payload.id,
          storyId: action.id,
          workspaceId,
        });
        await state.markProcessed(key);
        continue;
      }

      const comment = await client.postStoryComment(workspaceId, credentials, action.id, {
        text: buildReminder(addressee),
      });
      await state.markProcessed(key);
      if (comment?.alreadyCommented) {
        logger.info("Story already has a Team Cop comment; no reminder needed", {
          actor: addressee,
          deliveryId: payload.id,
          reason,
          storyId: action.id,
          workspaceId,
        });
        continue;
      }
      logger.info("Posted Team reminder", {
        actor: addressee,
        reason,
        storyId: action.id,
        workspaceId,
      });
    }
  };
}
