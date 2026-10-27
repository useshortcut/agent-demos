// Runs inside workerd too. Every agent fetch is routed here, including requests
// to an accidentally configured production URL. Nothing is forwarded online.
const posts = [];
const patches = [];
const requests = [];
const unexpected = [];
const origin = 'https://shortcut.mock';
const devinOrigin = 'https://devin.mock';
const session = { id: 'sess-1', turn: 1, version: 1, external_urls: [], outcome: null };
const activities = [];
let subscription = null;
const devin = { sessions: [], received: [] };

function reject(request, detail) {
  unexpected.push({ method: request.method, url: request.url, detail });
  return Response.json({ error: 'unexpected_test_request' }, { status: 500 });
}

const sessionView = () => ({ id: session.id, workspace_id: 'workspace', installation_id: 'installation', agent_member_id: 'agent-member',
  created_by: 'user', entity_type: 'story', entity_id: 123, thread_comment_id: null, status: 'active', turn: session.turn, version: session.version,
  plan: [], external_urls: session.external_urls, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  last_agent_activity_at: null, first_delivery_at: null, last_delivery_failed_at: null, last_delivery_error: null,
  acknowledged_at: null, stop_requested_at: null, closed_reason: null });

async function agentSessions(request, url) {
  if (url.search) return reject(request, 'Agent-session endpoints take no query');
  if (url.pathname === '/api/v4/acme/agent-sessions/subscription') {
    if (request.method !== 'PUT') return reject(request, 'Unexpected method');
    const body = await request.json();
    if (body.enabled !== true || Object.keys(body).length !== 1) return reject(request, 'Invalid subscription');
    subscription = body;
    return Response.json({ workspace_id: 'workspace', installation_id: 'installation', enabled: true, enabled_at: '2026-10-01T00:00:00Z', enabled_after_t: 1 });
  }
  if (url.pathname === `/api/v4/acme/agent-sessions/${session.id}`) {
    if (request.method === 'GET') return Response.json(sessionView());
    if (request.method !== 'PATCH') return reject(request, 'Unexpected method');
    const { version, external_urls: links, ...rest } = await request.json();
    if (Object.keys(rest).length || !Array.isArray(links) || links.length > 20 ||
        new Set(links.map((link) => link.url)).size !== links.length) return reject(request, 'Invalid session update');
    if (version !== session.version) return Response.json({ message: 'Session has changed; reload before updating.' }, { status: 409 });
    session.external_urls = links;
    session.version += 1;
    return Response.json(sessionView());
  }
  if (url.pathname !== `/api/v4/acme/agent-sessions/${session.id}/activities` || request.method !== 'POST') {
    return reject(request, 'Unmocked agent-session resource');
  }
  const { idempotency_key: key, turn, content, ephemeral, ...rest } = await request.json();
  if (Object.keys(rest).length || typeof key !== 'string' || !content?.body || content.body.length > 32768 ||
      !['thought', 'elicitation', 'response', 'error'].includes(content.type) || (ephemeral && content.type !== 'thought')) {
    return reject(request, 'Invalid activity');
  }
  const activity = { key, turn, content, ephemeral: ephemeral === true };
  const existing = activities.find((item) => item.key === key);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(activity)) return reject(request, 'Idempotency key reused with different content');
    return Response.json(existing, { status: 201 });
  }
  if (turn !== session.turn) return Response.json({ message: 'Activity belongs to an outdated turn.' }, { status: 409 });
  if (session.outcome) return Response.json({ message: 'A completed turn requires a new human prompt.' }, { status: 409 });
  activities.push(activity);
  if (content.type === 'response' || content.type === 'error') session.outcome = content.type;
  return Response.json(activity, { status: 201 });
}

const devinView = (item) => ({ session_id: item.id, url: item.url, status: item.status, status_detail: item.status_detail, tags: item.tags,
  org_id: 'synthetic-org', created_at: 1, updated_at: 1, acus_consumed: 0, pull_requests: [] });

async function devinApi(request, url) {
  if (request.headers.get('Authorization') !== 'Bearer synthetic-devin-key') return reject(request, 'Missing Devin key');
  if ([...url.searchParams.keys()].some((key) => !['tags', 'first', 'after'].includes(key))) return reject(request, 'Unknown Devin query parameter');
  const prefix = '/v3/organizations/synthetic-org/sessions';
  if (url.pathname === prefix && request.method === 'GET') {
    const tags = url.searchParams.getAll('tags');
    return Response.json({ items: devin.sessions.filter((item) => tags.every((tag) => item.tags.includes(tag))).map(devinView), end_cursor: null, has_next_page: false });
  }
  if (url.pathname === prefix && request.method === 'POST') {
    const { prompt, title, tags, ...rest } = await request.json();
    if (Object.keys(rest).length || typeof prompt !== 'string' || !prompt.includes('Please fix the login bug') ||
        !prompt.includes('https://app.shortcut.com/acme/story/123') || typeof title !== 'string' || !Array.isArray(tags)) {
      return reject(request, 'Invalid Devin session');
    }
    const n = devin.sessions.length + 1;
    const item = { id: `devin-${n}`, url: `https://app.devin.ai/sessions/${n}`, status: 'running', status_detail: 'finished', tags,
      messages: [{ event_id: 'evt-1', source: 'devin', message: 'Fixed the login bug.', created_at: 1 }] };
    devin.sessions.push(item);
    return Response.json({ ...devinView(item), status: 'new', status_detail: null });
  }
  const [, id, messages] = url.pathname.slice(prefix.length).match(/^\/([^/]+)(\/messages)?$/) ?? [];
  const item = devin.sessions.find((candidate) => candidate.id === id);
  if (!item) return reject(request, 'Unmocked Devin resource');
  if (messages && request.method === 'GET') return Response.json({ items: item.messages, end_cursor: null, has_next_page: false });
  if (messages && request.method === 'POST') {
    const { message } = await request.json();
    devin.received.push(message);
    item.messages.push({ event_id: `evt-${item.messages.length + 1}`, source: 'user', message, created_at: 2 },
      { event_id: `evt-${item.messages.length + 2}`, source: 'devin', message: 'Fixed Firefox too.', created_at: 3 });
    return Response.json(devinView(item));
  }
  if (!messages && request.method === 'GET') return Response.json(devinView(item));
  return reject(request, 'Unexpected Devin method');
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.origin === devinOrigin) {
      requests.push({ method: request.method, path: url.pathname, query: url.search });
      return devinApi(request, url);
    }
    if (url.origin !== origin) return reject(request, 'Unexpected origin');
    if (url.pathname === '/results') {
      return Response.json({ posts, patches, requests, unexpected, subscription, activities, session, devin });
    }
    if (url.pathname === '/advance-turn' && request.method === 'POST') {
      Object.assign(session, { turn: session.turn + 1, outcome: null });
      return Response.json(sessionView());
    }
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
    if (url.pathname.startsWith('/api/v4/acme/agent-sessions/')) return agentSessions(request, url);
    if (!url.searchParams.has('fields')) return reject(request, 'Missing field selection');
    if ([...url.searchParams.keys()].some((key) => !['fields', 'cursor', 'limit'].includes(key))) {
      return reject(request, 'Unknown query parameter');
    }
    if (url.searchParams.has('page') || (url.searchParams.has('cursor') && url.searchParams.has('limit'))) {
      return reject(request, 'Invalid cursor pagination');
    }
    const comments = /^\/api\/v4\/acme\/(stories|epics)\/\d+\/comments$/.test(url.pathname);
    const allowedFields = request.method !== 'GET' ? ['id'] : comments ? ['id', 'text', 'author', 'deleted', 'external_id'] :
      url.pathname.endsWith('/workflow-states') ? ['id', 'type'] : ['team', 'estimate', 'workflow_state'];
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
