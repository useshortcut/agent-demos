// The bridge scenario in runtime-tests/smoke.mjs reads this file. The Devin
// mock it talks to is ./smoke-vendor.js.
export const bindings = { DEVIN_API_KEY: 'synthetic-devin-key', DEVIN_ORG_ID: 'synthetic-org', DEVIN_API_BASE: 'https://devin.mock', ALLOWED_WORKSPACE_IDS: 'workspace' };

// The bridge's first Devin poll is 5 seconds out.
export const eventuallyMs = 20_000;

export const ack = 'devin-bridge:1:ack';
export const links = [{ label: 'Open in Devin', url: 'https://app.devin.ai/sessions/1' }];
export const responses = [/Fixed the login bug\./, /Fixed Firefox too\./];
