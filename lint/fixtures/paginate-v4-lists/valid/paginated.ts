import { ShortcutV4Client } from '@shortcut/client/v4';

export async function hasWarning(token: string, storyId: number): Promise<boolean> {
  const client = new ShortcutV4Client({ token });
  const workspace = client.workspace('acme');
  for await (const comment of client.paginate(workspace.listStoryComments(storyId, { fields: 'id,text', limit: 100 }))) {
    if (comment.text?.includes('estimate-guardian')) return true;
  }
  return false;
}
