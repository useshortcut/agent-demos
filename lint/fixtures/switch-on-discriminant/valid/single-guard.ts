type Phase = { kind: 'start' } | { kind: 'relay'; text: string } | { kind: 'idle' };

export function text(phase: Phase): string | null {
  if (phase.kind !== 'relay') return null;
  return phase.text;
}
