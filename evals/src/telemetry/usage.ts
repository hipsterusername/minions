import { UsageSchema, type Usage } from "../../schemas/index.js";

/** Original provider data, retained by callers alongside the normalized result. */
export interface RawUsageObservation {
  sourceId: string;
  participantId: string | null;
  turnId: string | null;
  /** A stable revision lets a corrected record replace, rather than add to, prior data. */
  revision?: number;
  /** Monotonic source position; cumulative snapshot covers all earlier observations. */
  sequence?: number;
  coversThroughSequence?: number;
  kind: "delta" | "turn_snapshot" | "cumulative_session";
  semantics: "codex_raw" | "minions_codex";
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  reportedCostUSD?: number;
  coverage?: "complete" | "partial" | "unavailable";
  coverageReasons?: string[];
}

export interface UsageAggregate { usage: Usage | null; coveredParticipants: string[]; coverage: Usage["coverage"]; reasons: string[]; }

function finite(value: number | undefined, field: string): number {
  const result = value ?? 0;
  if (!Number.isFinite(result) || result < 0) throw new Error(`invalid ${field}`);
  return result;
}

/** Converts the two verified Codex representations without guessing other providers. */
export function normalizeUsage(raw: RawUsageObservation): Usage {
  const input = finite(raw.input, "input"); const output = finite(raw.output, "output");
  const cacheRead = finite(raw.cacheRead, "cacheRead"); const cacheWrite = finite(raw.cacheWrite, "cacheWrite");
  const reasoning = raw.reasoning === undefined ? null : finite(raw.reasoning, "reasoning");
  if (reasoning !== null && reasoning > output) throw new Error("reasoning exceeds output");
  // Minions stores ordinary input after subtracting both cache categories; raw Codex input is inclusive.
  const totalInput = raw.semantics === "minions_codex" ? input + cacheRead + cacheWrite : input;
  if (raw.semantics === "codex_raw" && cacheRead + cacheWrite > input) throw new Error("cache categories overlap raw input");
  return UsageSchema.parse({ schemaVersion: 1, sourceId: raw.sourceId, participantId: raw.participantId,
    turnId: raw.turnId, observationKind: raw.kind, inputTokensTotal: totalInput,
    inputTokensUncached: raw.semantics === "minions_codex" ? input : raw.cacheRead === undefined && raw.cacheWrite === undefined ? null : input - cacheRead - cacheWrite,
    cacheReadTokens: raw.cacheRead === undefined ? null : cacheRead, cacheWriteTokens: raw.cacheWrite === undefined ? null : cacheWrite, outputTokensTotal: output,
    reasoningTokens: reasoning, totalTokens: totalInput + output, reportedCostUSD: raw.reportedCostUSD ?? null,
    estimatedCostUSD: null, coverage: raw.coverage ?? "complete", coverageReasons: raw.coverageReasons ?? [] });
}

/** Revision-aware accounting. Cumulative records contribute only their change since the last revision. */
export class UsageLedger {
  readonly #records = new Map<string, { raw: RawUsageObservation; usage: Usage }>();
  ingest(raw: RawUsageObservation): Usage | null {
    const key = `${raw.participantId ?? "session"}:${raw.turnId ?? ""}:${raw.sourceId}`;
    const prior = this.#records.get(key);
    if (prior && ((raw.revision ?? 0) < (prior.raw.revision ?? 0) || (raw.sequence !== undefined && prior.raw.sequence !== undefined && raw.sequence < prior.raw.sequence))) return null;
    const normalized = normalizeUsage(raw); this.#records.set(key, { raw, usage: normalized });
    return normalized;
  }
  aggregate(expectedParticipantIds: readonly string[] = []): UsageAggregate {
    const totals = { input: 0, uncached: 0, read: 0, write: 0, output: 0, cost: 0 };
    const seen = new Set<string>(); const reasons = new Set<string>(); let coverage: Usage["coverage"] = "complete";
    const records = [...this.#records.values()];
    const cumulative = new Map<string | null, typeof records[number]>();
    for (const record of records) if (record.raw.kind === "cumulative_session") {
      const prior = cumulative.get(record.raw.participantId);
      if (!prior || (record.raw.sequence ?? record.raw.revision ?? 0) >= (prior.raw.sequence ?? prior.raw.revision ?? 0)) cumulative.set(record.raw.participantId, record);
    }
    let allCostsKnown = true; let allUncachedKnown = true;
    for (const record of records) {
      const { usage, raw } = record;
      const snapshot = cumulative.get(raw.participantId);
      if (snapshot && snapshot !== record) {
        if (raw.kind === "cumulative_session") continue;
        if (snapshot.raw.coversThroughSequence === undefined || raw.sequence === undefined) {
          coverage = "partial"; reasons.add("ambiguous turn/session coverage interval"); continue;
        }
        if (raw.sequence <= snapshot.raw.coversThroughSequence) continue;
      }
      if (usage.inputTokensUncached === null) allUncachedKnown = false;
      if (usage.reportedCostUSD === null) allCostsKnown = false;
      if (usage.participantId) seen.add(usage.participantId); usage.coverageReasons.forEach((r) => reasons.add(r));
      if (usage.coverage !== "complete") coverage = "partial";
      // A cumulative source identity is upserted above, so its newest snapshot is
      // counted once. Deltas and per-turn snapshots retain distinct identities.
      const add = usage;
      totals.input += add.inputTokensTotal; totals.uncached += add.inputTokensUncached ?? 0;
      totals.read += add.cacheReadTokens ?? 0; totals.write += add.cacheWriteTokens ?? 0; totals.output += add.outputTokensTotal;
      totals.cost += add.reportedCostUSD ?? 0;
    }
    for (const id of expectedParticipantIds) if (!seen.has(id)) { coverage = "partial"; reasons.add(`missing usage for participant ${id}`); }
    if (!this.#records.size) return { usage: null, coveredParticipants: [], coverage: "unavailable", reasons: ["no usage observations"] };
    return { usage: UsageSchema.parse({ schemaVersion: 1, sourceId: "aggregate", participantId: null, turnId: null,
      observationKind: "delta", inputTokensTotal: totals.input, inputTokensUncached: allUncachedKnown ? totals.uncached : null,
      cacheReadTokens: totals.read || null, cacheWriteTokens: totals.write || null, outputTokensTotal: totals.output,
      reasoningTokens: null, totalTokens: totals.input + totals.output, reportedCostUSD: allCostsKnown ? totals.cost : null,
      estimatedCostUSD: null, coverage, coverageReasons: [...reasons] }), coveredParticipants: [...seen], coverage, reasons: [...reasons] };
  }
}
