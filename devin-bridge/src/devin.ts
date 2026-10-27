import type { DevinMessage, DevinState } from './bridge';
import { retryAfterMs } from './http';

export type DevinConfig = { apiKey: string; orgId: string; baseUrl?: string };

export type DevinSession = { id: string; url: string; state: DevinState; pullRequests: string[] };

export type DevinFailure = { kind: 'rate_limited'; retryAfterMs: number } | { kind: 'transient' } | { kind: 'rejected'; status: number };

export class DevinError extends Error {
  constructor(readonly failure: DevinFailure) {
    super('Devin request failed');
  }
}

const REQUEST_TIMEOUT_MS = 15_000;
const MESSAGE_PAGE_SIZE = 200;
const MAX_MESSAGE_PAGES = 10;
const SESSION_PAGE_SIZE = 100;
const MAX_SESSION_PAGES = 5;

const WORKING: DevinState = { kind: 'working' };
const RUNNING = new Map<string, DevinState>([
  ['working', WORKING],
  ['waiting_for_user', { kind: 'waiting', on: 'user' }],
  ['waiting_for_approval', { kind: 'waiting', on: 'approval' }],
  ['finished', { kind: 'finished' }],
]);

// `exit` is undocumented beyond the enum; it is what a terminated session reports.
function devinState(status: string, detail: string | null): DevinState {
  switch (status) {
    case 'running': return RUNNING.get(detail ?? 'working') ?? WORKING;
    case 'error': return { kind: 'failed', cause: 'error' };
    case 'exit': return { kind: 'failed', cause: 'exit' };
    case 'suspended': return { kind: 'failed', cause: 'suspended', reason: detail && /^[a-z_]{1,64}$/.test(detail) ? detail : 'unknown' };
    default: return WORKING;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

// Devin's docs do not say what created_at is; a number or a date string sorts, anything else sorts last.
function createdAt(value: unknown): number {
  const at = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : Infinity;
}

function parseSession(value: unknown): DevinSession & { tags: string[]; createdAt: number } {
  if (!isRecord(value) || typeof value.session_id !== 'string' || typeof value.url !== 'string' || typeof value.status !== 'string') {
    throw new DevinError({ kind: 'transient' });
  }
  const detail = typeof value.status_detail === 'string' ? value.status_detail : null;
  const pulls = Array.isArray(value.pull_requests) ? value.pull_requests : [];
  return {
    id: value.session_id,
    url: value.url,
    state: devinState(value.status, detail),
    pullRequests: pulls.flatMap((pr) => (isRecord(pr) && typeof pr.pr_url === 'string' ? [pr.pr_url] : [])),
    tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    createdAt: createdAt(value.created_at),
  };
}

function classify(response: Response): DevinFailure {
  if (response.status === 429) return { kind: 'rate_limited', retryAfterMs: retryAfterMs(response.headers.get('Retry-After'), Date.now()) };
  if (response.status >= 400 && response.status < 500) return { kind: 'rejected', status: response.status };
  return { kind: 'transient' };
}

export function devinClient({ apiKey, orgId, baseUrl = 'https://api.devin.ai' }: DevinConfig) {
  const root = `${baseUrl.replace(/\/+$/, '')}/v3/organizations/${encodeURIComponent(orgId)}`;

  async function call(method: string, path: string, { query, body, reply = true }: { query?: URLSearchParams; body?: unknown; reply?: boolean } = {}): Promise<unknown> {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${root}${path}${query ? `?${query}` : ''}`, {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        console.error('Devin request rejected', { method, path, status: response.status });
        throw new DevinError(classify(response));
      }
      if (reply) return await response.json();
      await response.body?.cancel();
      return undefined;
    } catch (error) {
      if (error instanceof DevinError) throw error;
      console.error('Devin request failed', { method, path, timeoutMs: REQUEST_TIMEOUT_MS });
      throw new DevinError({ kind: 'transient' });
    }
  }

  return {
    async createSession(prompt: string, title: string, tag: string): Promise<DevinSession> {
      return parseSession(await call('POST', '/sessions', { body: { prompt, title, tags: [tag] } }));
    },

    // The spec has a `tags` filter but does not document how arrays are
    // encoded; send it repeated and check the tag on what comes back. A
    // malformed page or a page that cannot be followed fails closed: it
    // never authorizes a create. Only the tagged sessions have to parse.
    // Oldest first, so a caller adopts the one an earlier attempt made.
    async findSessionsByTag(tag: string): Promise<DevinSession[]> {
      const found: ReturnType<typeof parseSession>[] = [];
      let after: string | null = null;
      for (let page = 0; page < MAX_SESSION_PAGES; page++) {
        const query = new URLSearchParams([['tags', tag], ['first', String(SESSION_PAGE_SIZE)], ...(after ? [['after', after]] : [])]);
        const result = await call('GET', '/sessions', { query });
        if (!isRecord(result) || !Array.isArray(result.items) || typeof result.has_next_page !== 'boolean') throw new DevinError({ kind: 'transient' });
        for (const item of result.items) if (isRecord(item) && Array.isArray(item.tags) && item.tags.includes(tag)) found.push(parseSession(item));
        if (!result.has_next_page) return found.sort((a, b) => a.createdAt - b.createdAt);
        if (typeof result.end_cursor !== 'string') throw new DevinError({ kind: 'transient' });
        after = result.end_cursor;
      }
      if (found.length === 0) console.warn('Devin Bridge found no tagged session within 5 pages and will create one', { tag });
      return found.sort((a, b) => a.createdAt - b.createdAt);
    },

    async getSession(id: string): Promise<DevinSession> {
      return parseSession(await call('GET', `/sessions/${encodeURIComponent(id)}`));
    },

    // The docs do not say whether a stored cursor can tail the list, so each
    // poll reads it from the start. User messages are kept: they place the
    // relayed reply in the list. A message that cannot be read leaves a gap,
    // and so does a page whose paging fields do not parse, so the list
    // counts as cut short.
    async listMessages(id: string): Promise<{ messages: DevinMessage[]; complete: boolean }> {
      const messages: DevinMessage[] = [];
      let dropped = false;
      let after: string | null = null;
      for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
        const query = new URLSearchParams({ first: String(MESSAGE_PAGE_SIZE), ...(after ? { after } : {}) });
        const result = await call('GET', `/sessions/${encodeURIComponent(id)}/messages`, { query });
        if (!isRecord(result) || !Array.isArray(result.items)) throw new DevinError({ kind: 'transient' });
        for (const item of result.items) {
          if (isRecord(item) && typeof item.event_id === 'string' && typeof item.source === 'string') {
            messages.push({ id: item.event_id, source: item.source, body: typeof item.message === 'string' ? item.message : '' });
          } else dropped = true;
        }
        if (result.has_next_page === false) return { messages, complete: !dropped };
        if (result.has_next_page !== true || typeof result.end_cursor !== 'string') break;
        after = result.end_cursor;
      }
      return { messages, complete: false };
    },

    // Devin has no idempotency key here.
    async sendMessage(id: string, message: string): Promise<void> {
      await call('POST', `/sessions/${encodeURIComponent(id)}/messages`, { body: { message }, reply: false });
    },

    async terminate(id: string): Promise<void> {
      await call('DELETE', `/sessions/${encodeURIComponent(id)}`, { reply: false });
    },
  };
}

export type DevinClient = ReturnType<typeof devinClient>;
