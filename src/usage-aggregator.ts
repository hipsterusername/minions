/**
 * Pure aggregation helpers for session cost and turn tracking.
 * The functions here are intentionally pure so the panel stays trivially
 * testable: subscribe to sdk_events, fold usage/done events through
 * `mergeUsageEvent` / `mergeDoneEvent`, and pass the map to
 * `aggregateGlobalUsage` for the popover.
 */

/** Per-session usage roll-up. */
export interface SessionUsage {
  totalCost: number;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cacheHitRate: number;
}

/** Empty per-session usage — used when a session is first observed. */
export function emptySessionUsage(): SessionUsage {
  return {
    totalCost: 0,
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    cacheHitRate: 0,
  };
}

/**
 * Called when a `usage` event arrives with `costUSD` set.
 * Replaces `totalCost` (the SDK reports cumulative totals, not deltas).
 */
export function mergeUsageEvent(
  current: SessionUsage,
  usage:
    | number
    | {
        source?: "assistant" | "result" | "turn_completed";
        input: number;
        output: number;
        cacheRead?: number;
        cacheCreation?: number;
        costUSD?: number;
      },
): SessionUsage {
  if (typeof usage === "number") return { ...current, totalCost: usage };
  if (usage.source === "result") {
    return { ...current, totalCost: usage.costUSD ?? current.totalCost };
  }
  return withCacheHitRate({
    ...current,
    totalCost: usage.costUSD ?? current.totalCost,
    input: current.input + usage.input,
    output: current.output + usage.output,
    cacheRead: current.cacheRead + (usage.cacheRead ?? 0),
    cacheCreation: current.cacheCreation + (usage.cacheCreation ?? 0),
  });
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
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cacheHitRate: number;
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
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  let sessionCount = 0;
  for (const s of sessions.values()) {
    if (hasUsage(s)) sessionCount++;
    totalCost += s.totalCost;
    totalTurns += s.turns;
    input += s.input;
    output += s.output;
    cacheRead += s.cacheRead;
    cacheCreation += s.cacheCreation;
  }
  return withCacheHitRate({
    totalCost,
    totalTurns,
    input,
    output,
    cacheRead,
    cacheCreation,
    cacheHitRate: 0,
    sessionCount,
  });
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

export function formatCacheHitRate(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export function formatSessionUsageLine(usage: SessionUsage): string | null {
  if (!hasTokenUsage(usage)) return null;
  return `in ${formatTokens(usage.input)} / out ${formatTokens(usage.output)} / cache ${formatCacheHitRate(usage.cacheHitRate)}`;
}

function withCacheHitRate<T extends { input: number; cacheRead: number }>(
  totals: T,
): T {
  const denominator = totals.input + totals.cacheRead;
  return {
    ...totals,
    cacheHitRate: denominator > 0 ? totals.cacheRead / denominator : 0,
  };
}

function hasUsage(s: SessionUsage): boolean {
  return s.totalCost > 0 || s.turns > 0 || hasTokenUsage(s);
}

function hasTokenUsage(s: SessionUsage): boolean {
  return s.input > 0 || s.output > 0 || s.cacheRead > 0 || s.cacheCreation > 0;
}
