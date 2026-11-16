// The bridge scenario in runtime-tests/smoke.mjs reads this file. The Managed
// Agents mock it talks to is ./smoke-vendor.js.
export const bindings = { ANTHROPIC_API_KEY: 'synthetic-claude-key', CLAUDE_AGENT_ID: 'agent_synthetic', CLAUDE_ENVIRONMENT_ID: 'env_synthetic',
  CLAUDE_CONSOLE_WORKSPACE_ID: 'default', ANTHROPIC_API_BASE: 'https://claude.mock', ALLOWED_WORKSPACE_IDS: 'workspace' };

// The bridge's first Claude poll is 5 seconds out.
export const eventuallyMs = 20_000;

export const ack = 'claude-bridge:1:ack';
export const links = [{ label: 'Open in Claude Console', url: 'https://platform.claude.com/workspaces/default/sessions/sesn_1' }];
export const responses = [/Fixed the login bug\./, /Fixed Firefox too\./];
