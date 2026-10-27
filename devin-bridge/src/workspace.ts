import { ShortcutOAuthError } from '@shortcut/client/v4';
import type { Env } from './index';
import { credentialsFromTokens, logFailure, oauthClient, type Credentials } from './shortcut';

// Shortcut rotates the refresh token on every refresh, and every session in a
// workspace shares it, so this object is the only one that refreshes.
export class Workspace {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

  fetch(request: Request): Promise<Response> {
    const next = this.queue.then(() => this.handle(request));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async handle(request: Request): Promise<Response> {
    const route = `${request.method} ${new URL(request.url).pathname}`;
    const storage = this.ctx.storage;
    if (route === 'PUT /credentials') {
      await storage.put('credentials', await request.json<Credentials>());
      return Response.json({ ok: true });
    }
    const current = await storage.get<Credentials>('credentials');
    if (!current) return Response.json({ error: 'not_connected' }, { status: 404 });
    if (route === 'GET /credentials') return Response.json(current);
    if (route !== 'POST /refresh') return Response.json({ error: 'not_found' }, { status: 404 });

    const { token, workspaceId } = await request.json<{ token: string; workspaceId: string }>();
    const alreadyRotated = token !== current.token;
    if (alreadyRotated) return Response.json(current);
    try {
      const refreshed = credentialsFromTokens(await oauthClient(this.env).refreshAccessToken(current.refreshToken), current);
      await storage.put('credentials', refreshed);
      console.log('Devin Bridge OAuth refreshed', { workspaceId, scopes: refreshed.scopes ?? 'unknown', expiresAt: refreshed.expiresAt });
      return Response.json(refreshed);
    } catch (error) {
      logFailure(error);
      // A 400 means the grant is revoked or the client credentials changed, so
      // retrying cannot help. refresh_conflict is a concurrent refresh.
      const rejected = error instanceof ShortcutOAuthError && error.status === 400 && error.error !== 'refresh_conflict';
      return Response.json({ error: rejected ? 'refresh_rejected' : 'refresh_failed' }, { status: rejected ? 401 : 502 });
    }
  }
}
