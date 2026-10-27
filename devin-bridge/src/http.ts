const MAX_RETRY_AFTER_MS = 600_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;

export function retryAfterMs(header: string | null, now: number): number {
  if (header !== null && /^\d+$/.test(header.trim())) return Math.min(MAX_RETRY_AFTER_MS, Number(header.trim()) * 1_000);
  const date = header === null ? NaN : Date.parse(header);
  return Number.isFinite(date) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - now)) : DEFAULT_RETRY_AFTER_MS;
}
