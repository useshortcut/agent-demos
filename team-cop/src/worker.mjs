import { Buffer } from "node:buffer";
import { ShortcutClient } from "./shortcut-client.mjs";
import { createTeamCopProcessor, verifyWebhookSignature } from "./team-cop.mjs";
import { DurableState } from "./durable-state.mjs";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const json = (body, status = 200) => Response.json(body, { status });

async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return json({ service: "Team Cop", status: "ok" });
    }
    if (!((request.method === "GET" && url.pathname === "/oauth/callback") ||
          (request.method === "POST" && url.pathname === "/webhook"))) {
      return json({ error: "not found" }, 404);
    }
    if (!["CLIENT_ID", "CLIENT_SECRET", "WEBHOOK_SECRET", "REDIRECT_URI"].every((key) => env[key]?.trim())) {
      return json({ error: "Configure Team Cop's Cloudflare secrets first." }, 503);
    }
    // One coordinator keeps token refresh and writes serialized for this small
    // demo. Its internal endpoints cannot be called through the public Worker.
    const stub = env.TEAM_COP.get(env.TEAM_COP.idFromName("team-cop"));
    if (url.pathname === "/oauth/callback") return stub.fetch(request);

    const raw = await readBody(request);
    if (raw === null) return json({ error: "payload too large" }, 413);
    if (!verifyWebhookSignature(raw, request.headers.get("Payload-Signature") ?? "", env.WEBHOOK_SECRET)) {
      return json({ error: "invalid signature" }, 401);
    }
    let payload;
    try { payload = JSON.parse(raw.toString("utf8")); }
    catch { return json({ error: "invalid JSON" }, 400); }
    if (payload?.type === "validation") return json({ ok: true });
    if (!Array.isArray(payload?.actions)) return json({ ignored: true });
    if (!payload.id || !payload.installation_id || !payload.workspace2?.id) {
      return json({ error: "missing delivery, installation, or workspace ID" }, 400);
    }
    return stub.fetch(new Request("https://internal/enqueue", {
      method: "POST", body: JSON.stringify(payload),
    }));
  },
};

export class TeamCop {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.state = new DurableState(ctx.storage);
    this.serial = Promise.resolve();
    this.client = new ShortcutClient({
      apiBase: env.SHORTCUT_API_BASE || "https://api.app.shortcut.com",
      clientId: env.CLIENT_ID,
      clientSecret: env.CLIENT_SECRET,
      redirectUri: env.REDIRECT_URI,
      state: this.state,
      checkExistingComments: true,
    });
    this.process = createTeamCopProcessor({ client: this.client, state: this.state });
    ctx.blockConcurrencyWhile(async () => {
      console.log("Team Cop Worker initialized", { workspaces: await this.state.listWorkspaces() });
    });
  }

  exclusive(fn) {
    const result = this.serial.then(fn);
    this.serial = result.catch(() => {});
    return result;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/enqueue") {
      await this.state.enqueueDelivery(await request.json());
      return json({ accepted: true }, 202);
    }
    return this.exclusive(async () => {
      console.log("Team Cop OAuth callback received", {
        hasCode: url.searchParams.has("code"), hasState: url.searchParams.has("state"),
      });
      if (url.searchParams.has("error")) return json({ error: "OAuth authorization denied" }, 400);
      const code = url.searchParams.get("code");
      if (!code) return json({ error: "missing authorization code" }, 400);
      try {
        const { workspaceId, credentials } = await this.client.exchangeAuthorizationCode(code);
        console.log("Team Cop connected", { workspaceId, slug: credentials.slug, scopes: credentials.scopes });
        return new Response("Team Cop connected. You can close this tab.", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      } catch (error) {
        console.error("Team Cop OAuth failed", { status: error.status, message: error.message });
        return json({ error: "Token exchange failed. Check Worker logs." }, 502);
      }
    });
  }

  async alarm() {
    return this.exclusive(async () => {
      try {
        // Bound work per alarm; additional deliveries remain scheduled.
        for (const item of (await this.state.dueDeliveries()).slice(0, 10)) {
          const delivery = await this.state.beginAttempt(item.key);
          if (!delivery) continue;
          try {
            await this.process(delivery.payload);
            await this.state.completeDelivery(item.key);
          } catch (error) {
            const failure = await this.state.failDelivery(item.key, error);
            console.error(failure.exhausted ? "Team Cop delivery exhausted after five retries" : "Team Cop delivery failed; retry scheduled", {
              ...failure, deliveryId: delivery.payload.id, message: error.message, status: error.status,
            });
          }
        }
      } finally {
        await this.state.schedule();
        console.log("Team Cop queue", {
          pending_deliveries: await this.state.countDeliveries(),
          failed_deliveries: await this.state.countFailedDeliveries(),
        });
      }
    });
  }
}
