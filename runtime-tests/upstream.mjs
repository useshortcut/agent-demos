// Runs inside workerd too. Every agent fetch is routed here, including requests
// to an accidentally configured production URL. Nothing is forwarded online.
const posts = [];
const patches = [];
const requests = [];
const unexpected = [];
const origin = 'https://shortcut.mock';

function reject(request, detail) {
  unexpected.push({ method: request.method, url: request.url, detail });
  return Response.json({ error: 'unexpected_test_request' }, { status: 500 });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.origin !== origin) return reject(request, 'Unexpected origin');
    if (url.pathname === '/results') return Response.json({ posts, patches, requests, unexpected });
    requests.push({ method: request.method, path: url.pathname, query: url.search });
    if (url.pathname === '/oauth-authorization-code-flow/token' && request.method === 'POST') {
      const body = new URLSearchParams(await request.text());
      if (body.get('code') !== 'synthetic-code' || body.get('grant_type') !== 'authorization_code' ||
          body.get('client_id') !== 'synthetic-client' || body.get('client_secret') !== 'synthetic-secret' ||
          body.get('redirect_uri') !== 'https://agent.test/oauth/callback') return reject(request, 'Invalid token exchange');
      return Response.json({
        access_token: 'synthetic-token', refresh_token: 'synthetic-refresh',
        access_token_expires_at: '2099-01-01T00:00:00Z', workspace2_id: 'workspace',
        workspace2_slug: 'acme', permission_id: 'agent-member', scope: 'read write comment-write',
      });
    }
    if (request.headers.get('Authorization') !== 'Bearer synthetic-token') return reject(request, 'Missing bearer token');
    if (!url.searchParams.has('fields')) return reject(request, 'Missing field selection');
    if ([...url.searchParams.keys()].some((key) => !['fields', 'cursor', 'limit'].includes(key))) {
      return reject(request, 'Unknown query parameter');
    }
    if (url.searchParams.has('page') || (url.searchParams.has('cursor') && url.searchParams.has('limit'))) {
      return reject(request, 'Invalid cursor pagination');
    }
    const comments = /^\/api\/v4\/acme\/(stories|epics)\/\d+\/comments$/.test(url.pathname);
    const allowedFields = request.method !== 'GET' ? ['id'] : comments ? ['id', 'text', 'author', 'deleted', 'external_id'] :
      url.pathname.endsWith('/workflow-states') ? ['id', 'type'] :
      url.pathname.includes('/members/') ? ['mention_name'] : ['team', 'estimate', 'workflow_state'];
    if (url.searchParams.get('fields').split(',').some((field) => !allowedFields.includes(field))) {
      return reject(request, 'Unknown field selection');
    }
    if (comments && request.method === 'POST') {
      if (url.searchParams.get('fields') !== 'id') return reject(request, 'Write fields must be id');
      const body = await request.json();
      posts.push({ path: url.pathname, ...body });
      return Response.json({ entity: { id: posts.length } });
    }
    if (request.method === 'PATCH' && url.pathname === '/api/v4/acme/stories/123') {
      patches.push(await request.json());
      return Response.json({ entity: { id: 123 } });
    }
    if (request.method !== 'GET') return reject(request, 'Unexpected method');
    if (url.pathname === '/api/v4/acme/members/user') return Response.json({ entity: { mention_name: 'ada' } });
    if (url.pathname === '/api/v4/acme/workflow-states') {
      return Response.json({ entities: [{ id: 2, type: 'started' }], current_page: 1, total_pages: 1 });
    }
    if (comments) {
      if (!url.searchParams.has('cursor')) {
        return Response.json({ entities: [], current_page: 1, total_pages: 2,
          next_page_url: `${url.origin}${url.pathname}?cursor=opaque%2Bcursor%3D&fields=${url.searchParams.get('fields')}` });
      }
      if (url.searchParams.get('cursor') !== 'opaque+cursor=') return reject(request, 'Cursor was not preserved');
      return Response.json({
        entities: posts.filter((post) => post.path === url.pathname).map((post, index) => ({
          id: index + 1, text: post.text, external_id: post.external_id, author: { id: 'agent-member' }, deleted: false,
        })), current_page: 2, total_pages: 2,
      });
    }
    if (url.pathname === '/api/v4/acme/stories/124') {
      return Response.json({ entity: { id: 124, team: null, estimate: 0, workflow_state: { id: 2 } } });
    }
    if (url.pathname === '/api/v4/acme/stories/123') {
      // Keep reporting started, even after a revert, so the second Guardian
      // delivery must find its existing warning instead of exiting on state.
      return Response.json({ entity: { id: 123, team: null, estimate: null, workflow_state: { id: 2 } } });
    }
    return reject(request, 'Unmocked API resource');
  },
};
