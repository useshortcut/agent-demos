// The bridge scenario in runtime-tests/smoke.mjs reads this file. The Agents
// API mock it talks to is ./smoke-vendor.js.
export const bindings = { OPENAI_API_KEY: 'synthetic-openai-key', OPENAI_AGENT_ID: 'agent_synthetic', OPENAI_API_BASE: 'https://openai.mock/v1', ALLOWED_WORKSPACE_IDS: 'workspace' };

// The bridge's first poll is 5 seconds out.
export const eventuallyMs = 20_000;

export const ack = 'openai-bridge:1:ack';
// The Agents API has no page for one session, so the card gets no link.
export const links = [];
export const responses = [/Fixed the login bug\./, /Fixed Firefox too\./];
