type Phase = { kind: 'start' } | { kind: 'relay'; text: string } | { kind: 'idle' };

export function describe(phase: Phase): string {
  if (phase.kind === 'start') return 'starting';
  if (phase.kind === 'relay') return phase.text;
  return 'idle';
}
