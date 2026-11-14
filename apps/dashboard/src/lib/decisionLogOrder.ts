// The dashboard's decision log says "Every call on record, newest first." and
// listed recent_decisions in stored order — the log is APPENDED to, so that was
// oldest first (journey BLOCKED 13). Newest first by decided_at; a tie, or an
// entry with no date, goes to the one later in the log, which is the later write.
export function decisionsNewestFirst<T extends { decided_at?: string }>(entries: T[]): T[] {
  const time = (entry: T) => {
    const parsed = Date.parse(entry?.decided_at || '');
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (time(b.entry) - time(a.entry)) || (b.index - a.index))
    .map(({ entry }) => entry);
}
