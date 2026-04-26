/**
 * Pure aggregation helpers for session token usage.
 *
 * The Claude Agent SDK emits a `result` message at the end of every turn that
 * carries `total_cost_usd` plus a `modelUsage` map keyed by full model id
 * (e.g. `claude-sonnet-4-20250514`). The frontend wants two views over this
 * data, both rolling-aggregated across the lifetime of the page:
 *
 *   1. Per-session totals — already shown as the dollar number next to each
 *      session in {@link SessionPanel}.
 *   2. Per-model token + cost breakdown — surfaced through the new "/usage"
 *      popover, fed by {@link aggregateGlobalUsage}.
 *
 * The functions here are intentionally pure so the popover stays trivially
 * testable: the panel listens for `sdk_event` results, threads them through
 * {@link mergeResultIntoSession}, and renders whatever this module produces.
 */
import type { ModelUsage, SdkResultMessage } from "./use-socket.ts";

/** Per-session usage roll-up, indexed by full model id. */
export interface SessionUsage {
  modelUsage: Record<string, ModelUsage>;
  totalCost: number;
  turns: number;
}

/** Empty usage record — a fresh `ModelUsage` with every counter at zero. */
export function emptyModelUsage(): ModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow: 0,
    maxOutputTokens: 0,
  };
}

/** Empty per-session usage — used when a session is first observed. */
export function emptySessionUsage(): SessionUsage {
  return { modelUsage: {}, totalCost: 0, turns: 0 };
}

/**
 * Fold a single SDK `result` message into the current per-session usage,
 * returning a new {@link SessionUsage} (the input is never mutated).
 *
 * The SDK reports cumulative session totals on every result, so we replace
 * `totalCost`/`turns` rather than summing them. `modelUsage` IS reset by the
 * SDK between sessions, so we treat each result's `modelUsage` map as the
 * authoritative latest value for those models — taking the max of the
 * incoming and existing tokens guards against the SDK occasionally emitting
 * a partial map mid-stream.
 */
export function mergeResultIntoSession(
  current: SessionUsage,
  result: SdkResultMessage,
): SessionUsage {
  const next: SessionUsage = {
    modelUsage: { ...current.modelUsage },
    totalCost: result.total_cost_usd ?? current.totalCost,
    turns: result.num_turns ?? current.turns,
  };
  for (const [model, usage] of Object.entries(result.modelUsage ?? {})) {
    const prev = next.modelUsage[model] ?? emptyModelUsage();
    next.modelUsage[model] = {
      inputTokens: Math.max(prev.inputTokens, usage.inputTokens),
      outputTokens: Math.max(prev.outputTokens, usage.outputTokens),
      cacheReadInputTokens: Math.max(
        prev.cacheReadInputTokens,
        usage.cacheReadInputTokens,
      ),
      cacheCreationInputTokens: Math.max(
        prev.cacheCreationInputTokens,
        usage.cacheCreationInputTokens,
      ),
      webSearchRequests: Math.max(
        prev.webSearchRequests,
        usage.webSearchRequests,
      ),
      costUSD: Math.max(prev.costUSD, usage.costUSD),
      contextWindow: usage.contextWindow || prev.contextWindow,
      maxOutputTokens: usage.maxOutputTokens || prev.maxOutputTokens,
    };
  }
  return next;
}

/** Aggregated breakdown across every session — what the popover renders. */
export interface GlobalUsage {
  /** One row per full model id, summed across every session. */
  byModel: Array<{ model: string; usage: ModelUsage }>;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  /** Number of sessions that have contributed at least one result. */
  sessionCount: number;
}

/**
 * Roll every per-session usage record up into a global breakdown for the
 * "/usage" popover. Sums each model's tokens/cost across sessions. The
 * resulting `byModel` list is sorted by descending cost so the most expensive
 * model lands at the top of the popover.
 */
export function aggregateGlobalUsage(
  sessions: ReadonlyMap<string, SessionUsage>,
): GlobalUsage {
  const merged: Record<string, ModelUsage> = {};
  let totalCost = 0;
  let sessionCount = 0;
  for (const session of sessions.values()) {
    if (Object.keys(session.modelUsage).length === 0 && session.totalCost === 0) {
      continue;
    }
    sessionCount += 1;
    totalCost += session.totalCost;
    for (const [model, usage] of Object.entries(session.modelUsage)) {
      const prev = merged[model] ?? emptyModelUsage();
      merged[model] = {
        inputTokens: prev.inputTokens + usage.inputTokens,
        outputTokens: prev.outputTokens + usage.outputTokens,
        cacheReadInputTokens:
          prev.cacheReadInputTokens + usage.cacheReadInputTokens,
        cacheCreationInputTokens:
          prev.cacheCreationInputTokens + usage.cacheCreationInputTokens,
        webSearchRequests: prev.webSearchRequests + usage.webSearchRequests,
        costUSD: prev.costUSD + usage.costUSD,
        contextWindow: Math.max(prev.contextWindow, usage.contextWindow),
        maxOutputTokens: Math.max(prev.maxOutputTokens, usage.maxOutputTokens),
      };
    }
  }
  const byModel = Object.entries(merged)
    .map(([model, usage]) => ({ model, usage }))
    .sort((a, b) => b.usage.costUSD - a.usage.costUSD);
  return {
    byModel,
    totalCost,
    totalInputTokens: byModel.reduce((s, r) => s + r.usage.inputTokens, 0),
    totalOutputTokens: byModel.reduce((s, r) => s + r.usage.outputTokens, 0),
    totalCacheReadTokens: byModel.reduce(
      (s, r) => s + r.usage.cacheReadInputTokens,
      0,
    ),
    totalCacheCreationTokens: byModel.reduce(
      (s, r) => s + r.usage.cacheCreationInputTokens,
      0,
    ),
    sessionCount,
  };
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
