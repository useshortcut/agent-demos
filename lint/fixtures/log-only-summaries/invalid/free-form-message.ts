export async function exchange(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) console.warn(`OAuth exchange failed: ${error.message}`);
  }
}
