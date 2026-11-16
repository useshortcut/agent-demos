// The Agents API mock for runtime-tests/smoke.mjs, which prepends this file to
// runtime-tests/upstream.mjs. It runs inside workerd and never goes online.
// Each input is answered at once: the turn it starts is completed with the
// agent's answer.
const vendor = (() => {
  const sessions = [];
  const received = [];
  const QUERY = ['metadata[shortcut_session]', 'order', 'limit', 'after'];
  const view = (item) => ({ id: item.id, object: 'agent.session', created_at: 1, last_active_at: 1, environment: { type: 'none' }, error: null,
    metadata: item.metadata, required_actions: [], status: 'idle', usage: null, vault_ids: [] });
  const page = (data) => Response.json({ object: 'list', data, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null, has_more: false });
  function answer(item, text, said) {
    const turn = `turn_${item.turns.length + 1}`;
    item.turns.push(turn);
    item.items.push({ id: `msg_${item.items.length + 1}`, type: 'message', role: 'user', phase: null, status: 'completed', content: [{ type: 'input_text', text }], turn_id: turn },
      { id: `msg_${item.items.length + 2}`, type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text: said }], turn_id: turn });
  }

  return {
    origin: 'https://openai.mock',
    results: () => ({ sessions, received }),
    async handle(request, url, reject) {
      if (request.headers.get('Authorization') !== 'Bearer synthetic-openai-key') return reject(request, 'Missing OpenAI key');
      if (request.headers.get('OpenAI-Beta') !== 'agents=v1') return reject(request, 'Missing OpenAI-Beta header');
      if ([...url.searchParams.keys()].some((key) => !QUERY.includes(key))) return reject(request, 'Unknown OpenAI query parameter');
      const prefix = '/v1/agents/sessions';
      if (url.pathname === prefix && request.method === 'GET') {
        const key = url.searchParams.get('metadata[shortcut_session]');
        return page(sessions.filter((item) => item.metadata.shortcut_session === key).map(view));
      }
      if (url.pathname === prefix && request.method === 'POST') {
        const { agent_id, environment, input, metadata, ...rest } = await request.json();
        if (Object.keys(rest).length || agent_id !== 'agent_synthetic' || environment?.type !== 'none' || typeof input !== 'string' ||
            !input.includes('Please fix the login bug') || !input.includes('https://app.shortcut.com/acme/story/123') || typeof metadata?.shortcut_session !== 'string') {
          return reject(request, 'Invalid OpenAI session');
        }
        const item = { id: `sess_${sessions.length + 1}`, metadata, items: [], turns: [] };
        answer(item, input, 'Fixed the login bug.');
        sessions.push(item);
        return Response.json(view(item));
      }
      const [, id, sub, turn, turnItems] = url.pathname.slice(prefix.length).match(/^\/([^/]+)(?:\/(items|events|turns)(?:\/([^/]+)(\/items)?)?)?$/) ?? [];
      const item = sessions.find((candidate) => candidate.id === id);
      if (!item) return reject(request, 'Unmocked OpenAI resource');
      if (!sub && request.method === 'GET') return Response.json(view(item));
      const list = (items) => {
        const ordered = url.searchParams.get('order') === 'asc' ? items : [...items].reverse();
        const after = url.searchParams.get('after');
        const from = after === null ? 0 : ordered.findIndex((entry) => entry.id === after) + 1;
        return page(ordered.slice(from, from + Number(url.searchParams.get('limit') ?? 20)));
      };
      if (sub === 'items' && request.method === 'GET') return list(item.items);
      if (sub === 'turns' && turn && request.method === 'GET') {
        if (!item.turns.includes(turn)) return reject(request, 'Unknown OpenAI turn');
        if (turnItems) return list(item.items.filter((entry) => entry.turn_id === turn));
        return Response.json({ id: turn, object: 'agent.session.turn', agent_id: 'agent_synthetic', session_id: item.id, status: 'completed', error: null,
          created_at: 1, started_at: 1, completed_at: 2, subagent_id: null, usage: null });
      }
      if (sub === 'events' && request.method === 'POST') {
        const { events: [event, ...more] } = await request.json();
        const text = event?.input?.[0]?.content?.[0]?.text;
        if (more.length || event?.type !== 'agent.session.input.message' || typeof text !== 'string' || !request.headers.get('Idempotency-Key')) {
          return reject(request, 'Invalid OpenAI event');
        }
        received.push(text);
        answer(item, text, 'Fixed Firefox too.');
        return new Response(null, { status: 202 });
      }
      return reject(request, 'Unexpected OpenAI method');
    },
  };
})();
