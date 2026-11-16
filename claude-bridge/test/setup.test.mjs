import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { it } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SETUP = new URL('../setup.mjs', import.meta.url).pathname;

// A local stand-in for the two create endpoints. setup.mjs never reaches the real API in a test.
async function mockApi(t, { refuse = null } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, path: request.url, auth: request.headers.authorization, beta: request.headers['anthropic-beta'], body: JSON.parse(body) });
    const id = request.url === refuse ? undefined : { '/v1/environments': 'env_created', '/v1/agents': 'agent_created' }[request.url];
    response.writeHead(id ? 200 : 400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(id ? { id } : { type: 'error', error: { type: 'invalid_request_error', message: 'private-response-body' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { requests, base: `http://127.0.0.1:${server.address().port}` };
}

it('creates the environment and the agent in agent.json, and prints their ids', async (t) => {
  const api = await mockApi(t);
  const { stdout } = await run(process.execPath, [SETUP], { env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_API_BASE: api.base } });
  assert.match(stdout, /^CLAUDE_AGENT_ID=agent_created$/m);
  assert.match(stdout, /^CLAUDE_ENVIRONMENT_ID=env_created$/m);
  const agent = JSON.parse(await readFile(new URL('../agent.json', import.meta.url), 'utf8'));
  assert.deepEqual(api.requests.map(({ method, path }) => [method, path]), [['POST', '/v1/environments'], ['POST', '/v1/agents']]);
  assert.deepEqual(api.requests[1].body, agent);
  assert.deepEqual(api.requests[0].body.config, { type: 'cloud', networking: { type: 'limited', allow_package_managers: true, allow_mcp_servers: true } });
  for (const request of api.requests) {
    assert.equal(request.auth, 'Bearer sk-ant-test');
    assert.ok(request.beta.split(',').includes('managed-agents-2026-04-01'));
  }
});

for (const [path, request] of [['/v1/environments', 'environments.create'], ['/v1/agents', 'agents.create']]) {
  it(`names the request and the status when ${request} is refused, and prints nothing of the response`, async (t) => {
    const api = await mockApi(t, { refuse: path });
    await assert.rejects(run(process.execPath, [SETUP], { env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_API_BASE: api.base } }), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stderr, `${request} failed with HTTP 400.\n`);
      assert.doesNotMatch(error.stdout, /CLAUDE_|private|sk-ant/);
      return true;
    });
  });
}

it('names the request when the API cannot be reached', async () => {
  await assert.rejects(run(process.execPath, [SETUP], { env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_API_BASE: 'http://127.0.0.1:1' } }), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stderr, 'environments.create failed.\n');
    return true;
  });
});

it('stops before any request when ANTHROPIC_API_KEY is unset', async (t) => {
  const api = await mockApi(t);
  await assert.rejects(run(process.execPath, [SETUP], { env: { PATH: process.env.PATH, ANTHROPIC_API_BASE: api.base } }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Set ANTHROPIC_API_KEY/);
    return true;
  });
  assert.deepEqual(api.requests, []);
});

it('ships an agent that keeps ask_user, needs no tool confirmation, and runs on Claude Opus 5.5', async () => {
  const agent = JSON.parse(await readFile(new URL('../agent.json', import.meta.url), 'utf8'));
  assert.equal(agent.model, 'claude-opus-5-5');
  const ask = agent.tools.find((tool) => tool.type === 'custom' && tool.name === 'ask_user');
  assert.deepEqual(ask.input_schema, { type: 'object', properties: { question: ask.input_schema.properties.question }, required: ['question'] });
  assert.equal(ask.input_schema.properties.question.type, 'string');
  const toolset = agent.tools.find((tool) => tool.type === 'agent_toolset_20260401');
  assert.equal(toolset.default_config.permission_policy.type, 'always_allow', 'the bridge cannot answer a confirmation');
});
