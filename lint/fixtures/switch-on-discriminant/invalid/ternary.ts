type Halted = { kind: 'ended'; url: string | null } | { kind: 'kept' } | { kind: 'unseen' };

export const outcome = (halted: Halted): string => (halted.kind === 'ended' ? 'terminated' : halted.kind === 'kept' ? 'kept' : 'not found');
