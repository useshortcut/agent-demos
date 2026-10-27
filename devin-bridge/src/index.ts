import { Hono } from 'hono';
import { html } from 'hono/html';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ShortcutOAuthTokens } from '@shortcut/client/v4';
import {
  ShortcutWebhookClient,
  ShortcutWebhookError,
  isShortcutSessionEventPayload,
  isShortcutValidationPayload,
} from '@shortcut/client/webhooks';
import { isStop } from './bridge';
import { credentialsFromTokens, logFailure, oauthClient, shortcutSessions, storeCredentials, workspaceAllowed } from './shortcut';

export { Session } from './session';
export { Workspace } from './workspace';

export type Env = {
  WORKSPACES: DurableObjectNamespace;
  SESSIONS: DurableObjectNamespace;
  CLIENT_ID: string;
  CLIENT_SECRET: string;
  REDIRECT_URI: string;
  WEBHOOK_SECRET: string;
  DEVIN_API_KEY: string;
  DEVIN_ORG_ID: string;
  ALLOWED_WORKSPACE_IDS: string;
  SHORTCUT_API_BASE?: string;
  DEVIN_API_BASE?: string;
};

// Deliveries need no allowlist: an empty one allows no workspace, and a stop
// still reaches the session it names, so clearing the list keeps cleanup working.
const DELIVERY_SECRETS = ['CLIENT_ID', 'CLIENT_SECRET', 'WEBHOOK_SECRET', 'REDIRECT_URI', 'DEVIN_API_KEY', 'DEVIN_ORG_ID'] as const;
const ALL_SECRETS = [...DELIVERY_SECRETS, 'ALLOWED_WORKSPACE_IDS'] as const;
function configured(env: Env, keys: typeof ALL_SECRETS | typeof DELIVERY_SECRETS): boolean {
  return keys.every((key) => typeof env[key] === 'string' && env[key].trim() !== '');
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;

async function readBody(request: Request): Promise<Uint8Array | null> {
  if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

const app = new Hono<{ Bindings: Env }>();
app.onError((_error, c) => {
  console.error('Devin Bridge request failed', { method: c.req.method, path: c.req.path });
  return c.text('Request failed. Check Worker logs.', 500);
});
app.use('/oauth/callback', async (c, next) => {
  if (!configured(c.env, ALL_SECRETS)) return c.json({ error: 'Configure the worker secrets first' }, 503);
  await next();
});
app.use('/webhook', async (c, next) => {
  if (!configured(c.env, DELIVERY_SECRETS)) return c.json({ error: 'Configure the worker secrets first' }, 503);
  await next();
});

app.get('/oauth/callback', async (c) => {
  if (c.req.query('error')) {
    console.error('Devin Bridge OAuth authorization rejected');
    return c.html(
      `<h2>&#10060; Authorization failed</h2>
       <p>Please close this tab and try connecting again.</p>`,
      400,
    );
  }
  const code = c.req.query('code');
  if (!code) return c.text('Missing code', 400);

  let tokens: ShortcutOAuthTokens;
  try {
    tokens = await oauthClient(c.env).exchangeAuthorizationCode(code);
  } catch (error) {
    logFailure(error);
    return c.text('Token exchange failed. Check worker logs.', 500);
  }

  const workspaceId = tokens.workspace2_id;
  if (!workspaceAllowed(c.env, workspaceId)) {
    console.warn('Devin Bridge refused a workspace that is not in ALLOWED_WORKSPACE_IDS', { workspaceId });
    return c.html(
      html`<h2>This workspace is not allowed</h2>
       <p>Add <code>${workspaceId}</code> to the worker's <code>ALLOWED_WORKSPACE_IDS</code> secret, then click Activate again.</p>`,
      403,
    );
  }
  const credentials = credentialsFromTokens(tokens);
  await storeCredentials(c.env, workspaceId, credentials);
  const sessionsEnabled = (await shortcutSessions(c.env, workspaceId, credentials).ensureSubscribed()).kind === 'ok';
  console.log('Devin Bridge connected', { workspaceId, scopes: credentials.scopes ?? 'unknown', sessionsEnabled });
  if (credentials.scopes && !['read', 'write'].every((scope) => credentials.scopes?.includes(scope))) {
    console.warn('Devin Bridge needs the Read and Write scopes', { workspaceId, scopes: credentials.scopes });
  }
  if (!sessionsEnabled) {
    return c.html(
      `<h2>Connected, but agent sessions are not enabled</h2>
       <p>The workspace is connected, but turning on agent sessions failed. Check worker logs, then click Activate on the agent app again to retry.</p>`,
      502,
    );
  }
  return c.html(
    `<h2>✅ Connected!</h2>
     <p>Your workspace is now connected and agent sessions are enabled.</p>
     <p>You can close this tab.</p>`,
  );
});

app.post('/webhook', async (c) => {
  const rawBody = await readBody(c.req.raw);
  if (rawBody === null) return c.json({ error: 'Payload too large' }, 413);

  let payload;
  try {
    ({ payload } = await new ShortcutWebhookClient(c.env.WEBHOOK_SECRET, { allowLegacySignature: false }).verifyBody(rawBody, c.req.raw.headers));
  } catch (error) {
    if (!(error instanceof ShortcutWebhookError)) throw error;
    if (error.status === 401) {
      console.error('Invalid webhook signature');
      return c.json({ error: 'Invalid signature' }, 401);
    }
    if (error.status === 413) return c.json({ error: 'Payload too large' }, 413);
    return c.json({ error: 'Invalid payload' }, error.status as ContentfulStatusCode);
  }

  if (isShortcutValidationPayload(payload)) return c.json({ ok: true });
  if (!isShortcutSessionEventPayload(payload)) return c.json({ ok: true, ignored: true });
  // A stop still reaches its session, so a workspace taken off the list can end the Devin sessions it started.
  if (!workspaceAllowed(c.env, payload.workspace_id) && !isStop(payload)) {
    console.warn('Devin Bridge ignored an event from a workspace that is not in ALLOWED_WORKSPACE_IDS', { workspaceId: payload.workspace_id });
    return c.json({ ok: true, ignored: true });
  }
  const session = c.env.SESSIONS.get(c.env.SESSIONS.idFromName(payload.session.id));
  return session.fetch(new Request('https://session/event', { method: 'POST', body: JSON.stringify(payload) }));
});

app.get('/', (c) => c.json({ status: 'ok', service: 'Shortcut Devin Bridge' }));

export default app;
