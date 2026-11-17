import { ShortcutV4Client } from '@shortcut/client/v4';

export async function hasWarning(token: string, storyId: number): Promise<boolean> {
  const workspace = new ShortcutV4Client({ token }).workspace('acme');
  const page = await workspace.listStoryComments(storyId, { fields: 'id,text', limit: 100 });
  return page.entities.some((comment) => comment.text?.includes('estimate-guardian') ?? false);
}
