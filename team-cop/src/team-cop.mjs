import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

export const REMINDER_TEXT = "Stories need to be in a Team! Please add one!";

export function reminderReason(action) {
  if (action?.entity_type !== "story") return null;
  if (action.action === "create") return "created";
  if (action.action !== "update" || !Array.isArray(action.changes)) return null;

  const startedChange = action.changes.find((change) => change?.attribute === "started");
  return startedChange?.adds?.includes(true) ? "started" : null;
}

export function buildReminder(mentionName) {
  const normalizedMentionName = String(mentionName).replace(/^@+/, "");
  return `@${normalizedMentionName} ${REMINDER_TEXT}`;
}

export function verifyWebhookSignature(rawBody, signature, secret) {
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(signature, "hex");

  return received.length === expected.length && timingSafeEqual(received, expected);
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

function externalId(key) {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `team-cop:${digest}`;
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

      const member = await client.getMember(workspaceId, credentials, actor.member_id);
      const mentionName = member.mention_name ?? actor.displayable_name;
      if (!mentionName) {
        logger.warn("Cannot address reminder because the actor has no mention name", {
          actorMemberId: actor.member_id,
          deliveryId: payload.id,
          storyId: action.id,
          workspaceId,
        });
        await state.markProcessed(key);
        continue;
      }

      await client.postStoryComment(workspaceId, credentials, action.id, {
        external_id: externalId(key),
        text: buildReminder(mentionName),
      });
      await state.markProcessed(key);
      logger.info("Posted Team reminder", {
        actor: mentionName,
        reason,
        storyId: action.id,
        workspaceId,
      });
    }
  };
}
