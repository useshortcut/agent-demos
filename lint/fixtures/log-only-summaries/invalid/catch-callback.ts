export function retire(run: () => Promise<void>): Promise<void> {
  return run().catch((reason) => console.error('Retirement failed', reason));
}
