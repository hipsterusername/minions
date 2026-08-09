import type Database from "better-sqlite3";
import type { NormalizedEvent } from "../shared/normalized-event.ts";

export interface SessionUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cacheHitRate: number;
}

export interface SessionUsageRowInput {
  sessionKey: string;
  role: string;
  model: string | null;
  source?: UsageSource | undefined;
  messageId?: string | undefined;
  turnId?: string | undefined;
  sdkSessionId?: string | undefined;
  usageIdentity?: string | undefined;
  input: number;
  output: number;
  cacheRead?: number | undefined;
  cacheCreation?: number | undefined;
  costUSD?: number | undefined;
  timestamp: number;
}

type UsageSource = NonNullable<Extract<NormalizedEvent, { kind: "usage" }>["source"]>;

export function emptyUsageTotals(): SessionUsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    cacheHitRate: 0,
  };
}

export function addUsageToTotals(
  current: SessionUsageTotals,
  usage: Extract<NormalizedEvent, { kind: "usage" }>,
): SessionUsageTotals {
  if (!isTokenUsageSource(usage.source)) return current;
  return withCacheHitRate({
    input: current.input + usage.input,
    output: current.output + usage.output,
    cacheRead: current.cacheRead + (usage.cacheRead ?? 0),
    cacheCreation: current.cacheCreation + (usage.cacheCreation ?? 0),
    cacheHitRate: 0,
  });
}

export function insertSessionUsage(
  db: Database.Database,
  row: SessionUsageRowInput,
): void {
  db.prepare(
    `INSERT INTO session_usage (
      session_key, role, model, source, message_id, turn_id,
      harness_session_id, usage_identity, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, cost_usd, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(
      session_key,
      COALESCE(harness_session_id, ''),
      source,
      usage_identity
    ) WHERE usage_identity <> ''
    DO UPDATE SET
      role = excluded.role,
      model = excluded.model,
      message_id = excluded.message_id,
      turn_id = excluded.turn_id,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_creation_tokens = excluded.cache_creation_tokens,
      cost_usd = excluded.cost_usd,
      created_at = excluded.created_at`,
  ).run(
    row.sessionKey,
    row.role,
    row.model,
    row.source ?? "assistant",
    row.messageId ?? null,
    row.turnId ?? null,
    row.sdkSessionId ?? null,
    row.usageIdentity ?? "",
    row.input,
    row.output,
    row.cacheRead ?? 0,
    row.cacheCreation ?? 0,
    row.costUSD ?? null,
    row.timestamp,
  );
}

export function getSessionUsageTotals(
  db: Database.Database,
  sessionKey: string,
): SessionUsageTotals {
  const row = db
    .prepare(
      `SELECT
        COALESCE(SUM(input_tokens), 0) AS input,
        COALESCE(SUM(output_tokens), 0) AS output,
        COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
        COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreation
       FROM session_usage
       WHERE session_key = ?
         AND COALESCE(source, 'assistant') IN ('assistant', 'turn_completed')`,
    )
    .get(sessionKey) as {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
  return withCacheHitRate({ ...row, cacheHitRate: 0 });
}

export function isTokenUsageSource(source: UsageSource | null | undefined): boolean {
  return source == null || source === "assistant" || source === "turn_completed";
}

function withCacheHitRate(totals: SessionUsageTotals): SessionUsageTotals {
  const denominator = totals.input + totals.cacheRead;
  return {
    ...totals,
    cacheHitRate: denominator > 0 ? totals.cacheRead / denominator : 0,
  };
}
