import { summarizeShortcutV4Error } from '@shortcut/client/v4';

export async function post(run: () => Promise<void>, storyId: number): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error('Comment failed', { storyId, ...summarizeShortcutV4Error(error) });
  }
}
