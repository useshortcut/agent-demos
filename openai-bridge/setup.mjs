// Saves the agent that agent.json describes and prints its id.
//   OPENAI_API_KEY=<key> npm run setup                          creates the agent
//   OPENAI_API_KEY=<key> OPENAI_AGENT_ID=<id> npm run setup     updates that agent
//   npm run setup -- --dry-run                                  prints the request and sends nothing
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import OpenAI from 'openai';

export async function saveAgent(client, config, agentId) {
  const agent = agentId ? await client.beta.agents.update(agentId, config) : await client.beta.agents.create(config);
  return agent.id;
}

export function problems(config) {
  const ask = config.tools?.find((tool) => tool.type === 'function' && tool.name === 'ask_user');
  if (!ask) return ['agent.json has no ask_user function, so the agent can only finish or fail. Add it back.'];
  if (ask.parameters?.properties?.question?.type !== 'string') return ['ask_user takes its question as a string named question. The bridge reads only that.'];
  return [];
}

async function main() {
  const config = JSON.parse(await readFile(new URL('agent.json', import.meta.url), 'utf8'));
  for (const problem of problems(config)) console.warn(problem);
  const agentId = process.env.OPENAI_AGENT_ID || undefined;
  if (process.argv.includes('--dry-run')) {
    console.log(`${agentId ? `POST /v1/agents/${agentId}` : 'POST /v1/agents'}\n${JSON.stringify(config, null, 2)}`);
    return;
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('Set OPENAI_API_KEY to an API key for the project that should hold the agent.');
    process.exitCode = 1;
    return;
  }
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, ...(process.env.OPENAI_API_BASE ? { baseURL: process.env.OPENAI_API_BASE } : {}) });
  try {
    console.log(`OPENAI_AGENT_ID=${await saveAgent(client, config, agentId)}`);
  } catch (error) {
    // The error carries the response body, which can repeat agent.json or name the account.
    const status = error instanceof OpenAI.APIError && typeof error.status === 'number' ? ` with HTTP ${error.status}` : '';
    console.error(`${agentId ? 'agents.update' : 'agents.create'} failed${status}.`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
