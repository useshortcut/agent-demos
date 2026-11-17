export function report(error: { status: number }, sessionId: string): void {
  console.warn('Backend request rejected', { sessionId, status: error.status });
}
