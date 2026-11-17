import { ShortcutV4Client } from '@shortcut/client/v4';

type Workspace = ReturnType<ShortcutV4Client['workspace']>;

async function listAll<T>(client: ShortcutV4Client, list: (workspace: Workspace) => Parameters<ShortcutV4Client['paginate']>[0]): Promise<T[]> {
  const all: T[] = [];
  for await (const entity of client.paginate(list(client.workspace('acme')))) all.push(entity as T);
  return all;
}

export const comments = (client: ShortcutV4Client, epic: boolean, id: number) =>
  listAll(client, (workspace) => (epic ? workspace.listEpicComments(id, { fields: 'id' }) : workspace.listStoryComments(id, { fields: 'id' })));
