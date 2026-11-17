type Event = { type: 'stop'; turn: number } | { type: 'reply'; turn: number; text: string };

export function count(events: Event[]): { stops: number; replies: number } {
  let stops = 0;
  let replies = 0;
  for (const event of events) {
    if (event.type === 'stop') stops += 1;
  }
  for (const event of events) {
    if (event.type === 'reply') replies += 1;
  }
  return { stops, replies };
}
