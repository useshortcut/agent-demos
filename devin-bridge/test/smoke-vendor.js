// The Devin API mock for runtime-tests/smoke.mjs, which prepends this file to
// runtime-tests/upstream.mjs. It runs inside workerd and never goes online.
const vendor = (() => {
  const sessions = [];
  const received = [];
  const view = (item) => ({ session_id: item.id, url: item.url, status: item.status, status_detail: item.status_detail, tags: item.tags,
    org_id: 'synthetic-org', created_at: 1, updated_at: 1, acus_consumed: 0, pull_requests: [] });

  return {
    origin: 'https://devin.mock',
    results: () => ({ sessions, received }),
    async handle(request, url, reject) {
      if (request.headers.get('Authorization') !== 'Bearer synthetic-devin-key') return reject(request, 'Missing Devin key');
      if ([...url.searchParams.keys()].some((key) => !['tags', 'first', 'after'].includes(key))) return reject(request, 'Unknown Devin query parameter');
      const prefix = '/v3/organizations/synthetic-org/sessions';
      if (url.pathname === prefix && request.method === 'GET') {
        const tags = url.searchParams.getAll('tags');
        return Response.json({ items: sessions.filter((item) => tags.every((tag) => item.tags.includes(tag))).map(view), end_cursor: null, has_next_page: false });
      }
      if (url.pathname === prefix && request.method === 'POST') {
        const { prompt, title, tags, ...rest } = await request.json();
        if (Object.keys(rest).length || typeof prompt !== 'string' || !prompt.includes('Please fix the login bug') ||
            !prompt.includes('https://app.shortcut.com/acme/story/123') || typeof title !== 'string' || !Array.isArray(tags)) {
          return reject(request, 'Invalid Devin session');
        }
        const n = sessions.length + 1;
        const item = { id: `devin-${n}`, url: `https://app.devin.ai/sessions/${n}`, status: 'running', status_detail: 'finished', tags,
          messages: [{ event_id: 'evt-1', source: 'devin', message: 'Fixed the login bug.', created_at: 1 }] };
        sessions.push(item);
        return Response.json({ ...view(item), status: 'new', status_detail: null });
      }
      const [, id, messages] = url.pathname.slice(prefix.length).match(/^\/([^/]+)(\/messages)?$/) ?? [];
      const item = sessions.find((candidate) => candidate.id === id);
      if (!item) return reject(request, 'Unmocked Devin resource');
      if (messages && request.method === 'GET') return Response.json({ items: item.messages, end_cursor: null, has_next_page: false });
      if (messages && request.method === 'POST') {
        const { message } = await request.json();
        received.push(message);
        item.messages.push({ event_id: `evt-${item.messages.length + 1}`, source: 'user', message, created_at: 2 },
          { event_id: `evt-${item.messages.length + 2}`, source: 'devin', message: 'Fixed Firefox too.', created_at: 3 });
        return Response.json(view(item));
      }
      if (!messages && request.method === 'GET') return Response.json(view(item));
      return reject(request, 'Unexpected Devin method');
    },
  };
})();
