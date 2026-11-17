type Store = { listKeys(prefix: string): Promise<string[]> };

export const keys = (store: Store): Promise<string[]> => store.listKeys('creds:');
