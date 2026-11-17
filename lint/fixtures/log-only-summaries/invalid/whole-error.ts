export async function refresh(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error('Token refresh failed', error);
  }
}
