export async function post(run: () => Promise<void>, storyId: number): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error('Comment failed', { storyId, error });
  }
}
