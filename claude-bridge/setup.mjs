// Creates a Managed Agents environment and the agent in agent.json, and
// prints the two ids the Worker needs as secrets. Every run creates a new pair.
//   ANTHROPIC_API_KEY=<key> npm run setup
import Anthropic, { APIError } from '@anthropic-ai/sdk';
import { readFile } from 'node:fs/promises';

// Sessions run in a cloud container that can reach package registries and
// the agent's MCP servers. Edit this to open more hosts, or to use `unrestricted`.
const ENVIRONMENT = {
  name: 'Shortcut Claude Bridge',
  config: { type: 'cloud', networking: { type: 'limited', allow_package_managers: true, allow_mcp_servers: true } },
};

const { ANTHROPIC_API_KEY: apiKey, ANTHROPIC_API_BASE: baseURL } = process.env;
if (!apiKey) {
  console.error('Set ANTHROPIC_API_KEY to a Claude Console API key, then run `npm run setup` again.');
  process.exit(1);
}
const agent = JSON.parse(await readFile(new URL('agent.json', import.meta.url), 'utf8'));
const client = new Anthropic({ apiKey, baseURL: baseURL || 'https://api.anthropic.com', logLevel: 'off' });

// An SDK error carries the response body, so only the request and the status are printed.
async function created(request, create) {
  try {
    return await create();
  } catch (error) {
    console.error(`${request} failed${error instanceof APIError && error.status ? ` with HTTP ${error.status}` : ''}.`);
    process.exit(1);
  }
}

const environment = await created('environments.create', () => client.beta.environments.create(ENVIRONMENT));
const { id } = await created('agents.create', () => client.beta.agents.create(agent));
console.log('Push these as Worker secrets:');
console.log(`CLAUDE_AGENT_ID=${id}`);
console.log(`CLAUDE_ENVIRONMENT_ID=${environment.id}`);
