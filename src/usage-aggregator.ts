/**
 * Pure aggregation helpers for session cost and turn tracking.
 *
 * Phase 3: NormalizedEvent delivers cost via a `usage` event
 * (`costUSD` = total session cost so far) and turn count via a `done`
 * event (`turns`). These replace the old `result` message fields.
 *
 * The functions here are intentionally pure so the panel stays trivially
 * testable: subscribe to sdk_events, fold usage/done events through
 * `mergeUsageEvent` / `mergeDoneEvent`, and pass the map to
 * `aggregateGlobalUsage` for the popover.
 */

/** Per-session usage roll-up. */
export interface SessionUsage {
  totalCost: number;
  turns: number;
}

/** Empty per-session usage — used when a session is first observed. */
export function emptySessionUsage(): SessionUsage {
  return { totalCost: 0, turns: 0 };
}

/**
 * Called when a `usage` event arrives with `costUSD` set.
 * Replaces `totalCost` (the SDK reports cumulative totals, not deltas).
 */
export function mergeUsageEvent(
  current: SessionUsage,
  costUSD: number,
): SessionUsage {
  return { ...current, totalCost: costUSD };
}

/**
 * Called when a `done` event arrives with `turns` set.
 */
export function mergeDoneEvent(
  current: SessionUsage,
  turns: number,
): SessionUsage {
  return { ...current, turns };
}

/** Aggregated breakdown across every session — what the popover renders. */
export interface GlobalUsage {
  totalCost: number;
  totalTurns: number;
  /** Number of sessions that have contributed at least one usage/done event. */
  sessionCount: number;
}

/**
 * Roll every per-session usage record up into a global breakdown for the
 * "/usage" popover.
 */
export function aggregateGlobalUsage(
  sessions: ReadonlyMap<string, SessionUsage>,
): GlobalUsage {
  let totalCost = 0;
  let totalTurns = 0;
  let sessionCount = 0;
  for (const s of sessions.values()) {
    if (s.totalCost > 0 || s.turns > 0) sessionCount++;
    totalCost += s.totalCost;
    totalTurns += s.turns;
  }
  return { totalCost, totalTurns, sessionCount };
}

/**
 * Strip the `claude-` prefix and trailing date suffix from a full model id
 * so the popover can show a compact label (e.g. `sonnet-4` instead of
 * `claude-sonnet-4-20250514`). Falls back to the raw id when the regex
 * doesn't match.
 */
export function shortModelLabel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{6,8}$/, "");
}

/** Format a token count as `1.2k`, `345`, or `2.3M`. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
