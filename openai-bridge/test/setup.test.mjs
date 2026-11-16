import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { problems, saveAgent } from '../setup.mjs';

const config = JSON.parse(await readFile(new URL('../agent.json', import.meta.url), 'utf8'));

function client(log) {
  return new OpenAI({
    apiKey: 'sk-test',
    baseURL: 'https://openai.example/v1',
    maxRetries: 0,
    fetch: async (url, init) => {
      log.push({ method: init.method, path: new URL(url).pathname, beta: new Headers(init.headers).get('OpenAI-Beta'), body: JSON.parse(init.body) });
      return Response.json({ id: 'agent_saved', object: 'agent', ...config });
    },
  });
}

it('creates the agent agent.json describes and returns its id', async () => {
  const log = [];
  assert.equal(await saveAgent(client(log), config), 'agent_saved');
  assert.deepEqual(log, [{ method: 'POST', path: '/v1/agents', beta: 'agents=v1', body: config }]);
});

it('updates the agent when an id is given', async () => {
  const log = [];
  assert.equal(await saveAgent(client(log), config, 'agent_saved'), 'agent_saved');
  assert.deepEqual(log.map(({ method, path }) => [method, path]), [['POST', '/v1/agents/agent_saved']]);
});

it('ships ask_user with a question string, and names an agent.json that drops it', () => {
  assert.deepEqual(problems(config), []);
  assert.match(problems({ ...config, tools: [] })[0], /no ask_user/);
  assert.match(problems({ ...config, tools: [{ ...config.tools[0], parameters: { type: 'object', properties: {} } }] })[0], /question/);
});

// Runs setup.mjs with `fetch` replaced, so nothing goes online.
function runSetup(fetchSource, env) {
  const stub = `data:text/javascript,${encodeURIComponent(`globalThis.fetch = ${fetchSource};`)}`;
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', stub, fileURLToPath(new URL('../setup.mjs', import.meta.url))], { env: { PATH: process.env.PATH, ...env } },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
}

for (const [what, fetchSource, env, line] of [
  ['the API rejects the create', `async () => Response.json({ error: { type: 'invalid_request_error', code: 'invalid_request', message: 'private-agent-configuration' } }, { status: 400 })`,
    {}, 'agents.create failed with HTTP 400.'],
  ['the API rejects the update', `async () => Response.json({ error: { message: 'private-agent-configuration' } }, { status: 404 })`, { OPENAI_AGENT_ID: 'agent_saved' }, 'agents.update failed with HTTP 404.'],
  ['the request never gets an answer', `async () => { throw new TypeError('private-network-detail'); }`, {}, 'agents.create failed.'],
]) {
  it(`prints the request and its status, and nothing from the response, when ${what}`, async () => {
    const { code, stdout, stderr } = await runSetup(fetchSource, { OPENAI_API_KEY: 'sk-synthetic', ...env });
    assert.deepEqual([code, stdout, stderr], [1, '', `${line}\n`]);
  });
}
