// The Managed Agents API mock for runtime-tests/smoke.mjs, which prepends this
// file to runtime-tests/upstream.mjs. It runs inside workerd and never goes
// online. A session opens empty, so its first message is the opening request
// and only the later ones count as received.
const vendor = (() => {
  const sessions = [];
  const received = [];
  const answers = ['Fixed the login bug.', 'Fixed Firefox too.'];
  let ids = 0;
  let clock = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 1) + ++clock * 1000).toISOString();
  const event = (type, fields = {}) => ({ id: `sevt_${++ids}`, type, ...fields, processed_at: stamp() });
  const view = (item) => ({ type: 'session', id: item.id, status: item.status, title: item.title, metadata: item.metadata });
  const LIST = ['types[]', 'order', 'limit', 'page', 'created_at[gte]'];

  return {
    origin: 'https://claude.mock',
    results: () => ({ sessions: sessions.map(({ id, opened }) => ({ id, opened })), received }),
    async handle(request, url, reject) {
      if (request.headers.get('Authorization') !== 'Bearer synthetic-claude-key') return reject(request, 'Missing Claude key');
      if (!(request.headers.get('anthropic-beta') ?? '').split(',').includes('managed-agents-2026-04-01')) return reject(request, 'Missing Managed Agents beta header');
      if ([...url.searchParams.keys()].some((key) => !LIST.includes(key))) return reject(request, 'Unknown Claude query parameter');
      if (url.pathname === '/v1/sessions' && request.method === 'POST') {
        const { agent, environment_id, title, metadata, ...rest } = await request.json();
        if (Object.keys(rest).length || agent !== 'agent_synthetic' || environment_id !== 'env_synthetic' || typeof title !== 'string' || typeof metadata?.shortcut_session !== 'string') {
          return reject(request, 'Invalid Claude session');
        }
        const item = { id: `sesn_${sessions.length + 1}`, status: 'idle', title, metadata, opened: null, events: [] };
        sessions.push(item);
        return Response.json(view(item));
      }
      const [, id, events] = url.pathname.match(/^\/v1\/sessions\/([^/]+)(\/events)?$/) ?? [];
      const item = sessions.find((candidate) => candidate.id === id);
      if (!item) return reject(request, 'Unmocked Claude resource');
      if (!events && request.method === 'GET') return Response.json(view(item));
      if (events && request.method === 'GET') {
        const types = url.searchParams.getAll('types[]');
        const since = url.searchParams.get('created_at[gte]');
        const data = item.events.filter((e) => (!types.length || types.includes(e.type)) && (since === null || e.processed_at >= since));
        if (url.searchParams.get('order') === 'desc') data.reverse();
        return Response.json({ data: data.slice(0, Number(url.searchParams.get('limit') ?? 1000)), next_page: null });
      }
      if (events && request.method === 'POST') {
        const { events: [sent], ...rest } = await request.json();
        if (Object.keys(rest).length || sent?.type !== 'user.message' || sent.content?.[0]?.type !== 'text') return reject(request, 'Unexpected Claude event');
        const { text } = sent.content[0];
        if (item.opened === null) {
          if (!text.includes('Please fix the login bug') || !text.includes('https://app.shortcut.com/acme/story/123')) return reject(request, 'Invalid opening request');
          item.opened = text;
        } else received.push(text);
        const message = event('user.message', { content: sent.content });
        item.events.push(message, event('session.status_running'), event('agent.message', { content: [{ type: 'text', text: answers[item.events.length ? 1 : 0] }] }),
          event('session.status_idle', { stop_reason: { type: 'end_turn' }, stop_details: null }));
        // The send's answer shows the message as it arrived: queued.
        return Response.json({ data: [{ ...message, processed_at: null }] });
      }
      return reject(request, 'Unexpected Claude method');
    },
  };
})();
