export async function refresh(run: () => Promise<void>, workspaceId: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error('Token refresh failed', { workspaceId, name: error instanceof Error ? error.name : 'unknown' });
  }
}
