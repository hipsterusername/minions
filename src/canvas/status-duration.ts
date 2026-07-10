export type StatusEntry = { status: string; since: number };

export function reconcileStatusDurations(
  prev: Map<string, StatusEntry>,
  current: Array<{ id: string; status: string }>,
  now: number,
): Map<string, StatusEntry> {
  const next = new Map<string, StatusEntry>();

  for (const item of current) {
    const previous = prev.get(item.id);
    next.set(item.id, {
      status: item.status,
      since: previous?.status === item.status ? previous.since : now,
    });
  }

  return next;
}

export function formatStatusDuration(sinceMs: number, nowMs: number): string {
  const elapsedMs = Math.max(0, nowMs - sinceMs);
  const totalMinutes = Math.floor(elapsedMs / 60_000);

  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (totalHours < 24) {
    return `${totalHours}h ${minutes}m`;
  }

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${days}d ${hours}h`;
}
