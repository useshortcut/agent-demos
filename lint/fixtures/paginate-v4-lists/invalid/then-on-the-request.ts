import { ShortcutV4Client } from '@shortcut/client/v4';

export function stateNames(token: string): Promise<string[]> {
  const workspace = new ShortcutV4Client({ token }).workspace('acme');
  return workspace.listWorkflowStates({ fields: 'id,name', limit: 100 }).then((page) => page.entities.map((state) => state.name ?? ''));
}
