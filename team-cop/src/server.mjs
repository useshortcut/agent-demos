import { createServer } from "node:http";
import { resolve } from "node:path";

import { ShortcutClient } from "./shortcut-client.mjs";
import { StateStore } from "./state-store.mjs";
import { createTeamCopProcessor, verifyWebhookSignature } from "./team-cop.mjs";

const MAX_BODY_BYTES = 2 * 1_024 * 1_024;
const RETRY_POLL_MS = 1_000;

function requireEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
}

function html(response, status, body) {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

const config = {
  apiBase: process.env.SHORTCUT_API_BASE?.trim() || "https://api.app.shortcut.com",
  clientId: requireEnvironment("CLIENT_ID"),
  clientSecret: requireEnvironment("CLIENT_SECRET"),
  port: parsePort(process.env.PORT ?? "8787"),
  redirectUri: requireEnvironment("REDIRECT_URI"),
  statePath: resolve(process.env.STATE_PATH?.trim() || ".data/state.json"),
  webhookSecret: requireEnvironment("WEBHOOK_SECRET"),
};

const state = await StateStore.open(config.statePath);
const shortcutClient = new ShortcutClient({
  apiBase: config.apiBase,
  checkExistingComments: true,
  clientId: config.clientId,
  clientSecret: config.clientSecret,
  logger: console,
  redirectUri: config.redirectUri,
  state,
});
const processObserverPayload = createTeamCopProcessor({ client: shortcutClient, state });

let draining = false;
async function drainDeliveries() {
  if (draining) return;
  draining = true;
  try {
    for (const delivery of await state.dueDeliveries()) {
      try {
        await processObserverPayload(delivery.payload);
        await state.completeDelivery(delivery.key);
      } catch (error) {
        const failure = await state.failDelivery(delivery.key, error);
        const details = {
          attempt: failure.attempts,
          deliveryId: delivery.payload.id,
          error,
          retriesRemaining: failure.retriesRemaining,
        };

        if (failure.exhausted) {
          console.error("Team Cop delivery exhausted after five retries", details);
        } else {
          console.error("Team Cop delivery failed; retry scheduled", details);
        }
      }
    }
  } finally {
    draining = false;
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");

  try {
    if (request.method === "GET" && url.pathname === "/") {
      json(response, 200, {
        connected_workspaces: await state.listWorkspaces(),
        failed_deliveries: await state.countFailedDeliveries(),
        pending_deliveries: await state.countDeliveries(),
        service: "Team Cop",
        status: "ok",
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/oauth/callback") {
      console.log("Team Cop OAuth callback received", {
        hasCode: url.searchParams.has("code"),
        hasState: url.searchParams.has("state"),
      });

      const oauthError = url.searchParams.get("error");
      if (oauthError) {
        html(
          response,
          400,
          `<h1>Authorization failed</h1><p>${escapeHtml(oauthError)}: ${escapeHtml(url.searchParams.get("error_description") ?? "No description provided")}</p>`,
        );
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        html(response, 400, "<h1>Authorization failed</h1><p>Missing authorization code.</p>");
        return;
      }

      const { credentials, workspaceId } = await shortcutClient.exchangeAuthorizationCode(code);
      console.log("Team Cop connected", {
        scopes: credentials.scopes,
        slug: credentials.slug,
        workspaceId,
      });
      html(
        response,
        200,
        `<h1>Team Cop connected</h1><p>Workspace <strong>${escapeHtml(credentials.slug)}</strong> is ready. You can close this tab.</p>`,
      );
      void drainDeliveries();
      return;
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      const rawBody = await readBody(request);
      const signatureHeader = request.headers["payload-signature"];
      const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : (signatureHeader ?? "");
      if (!verifyWebhookSignature(rawBody, signature, config.webhookSecret)) {
        json(response, 401, { error: "invalid signature" });
        return;
      }

      let payload;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        json(response, 400, { error: "invalid JSON" });
        return;
      }

      if (payload.type === "validation") {
        console.log("Shortcut validated the Team Cop webhook");
        json(response, 200, { ok: true });
        return;
      }

      if (!Array.isArray(payload.actions)) {
        console.log("Ignoring non-observer webhook", { deliveryId: payload.id });
        json(response, 200, { ignored: true });
        return;
      }

      await state.enqueueDelivery(payload);
      json(response, 202, { accepted: true });
      void drainDeliveries();
      return;
    }

    json(response, 404, { error: "not found" });
  } catch (error) {
    console.error("Team Cop request failed", error);
    json(response, 500, { error: "internal server error" });
  }
});

server.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

const retryTimer = setInterval(() => void drainDeliveries(), RETRY_POLL_MS);

function shutdown(signal) {
  console.log(`Received ${signal}; stopping Team Cop`);
  clearInterval(retryTimer);
  server.close(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.listen(config.port, "127.0.0.1", async () => {
  console.log(`Team Cop listening at http://localhost:${config.port}`);
  console.log(`OAuth callback: ${config.redirectUri}`);
  console.log(`Shortcut API: ${config.apiBase}`);
  console.log("OAuth configuration loaded", {
    clientIdConfigured: Boolean(config.clientId),
    clientSecretConfigured: Boolean(config.clientSecret),
    redirectUriConfigured: Boolean(config.redirectUri),
  });
  const connectedWorkspaces = await state.listWorkspaces();
  if (connectedWorkspaces.length === 0) {
    console.log("OAuth scopes: no connected workspaces");
  } else {
    for (const workspace of connectedWorkspaces) {
      console.log("OAuth scopes", {
        scopes: workspace.scopes ?? "unknown; reauthorize once to record scopes",
        slug: workspace.slug,
        workspaceId: workspace.id,
      });
    }
  }
  void drainDeliveries();
});
