type Phase = { kind: 'start' } | { kind: 'relay'; text: string } | { kind: 'idle' };

export function describe(phase: Phase): string {
  switch (phase.kind) {
    case 'start':
      return 'starting';
    case 'relay':
      return phase.text;
    case 'idle':
      return 'idle';
  }
}
