import type Database from "better-sqlite3";
import type { Outcome } from "../shared/work-item-lifecycle.ts";

export type InvocationPhase = "opening" | "running" | "terminal" | "lost";
export type InvocationTerminalKind = "clean" | "error" | "cancelled" | "lost";
export type InvocationTerminalSource = "provider" | "adapter" | "server" | "boot";
export type InvocationTerminationIntent =
  | "stop" | "close" | "remove" | "abort" | "timeout" | "shutdown";

export interface RunInvocationRow {
  sequence: number;
  run_key: string;
  provider_generation: number;
  phase: InvocationPhase;
  terminal_kind: InvocationTerminalKind | null;
  terminal_source: InvocationTerminalSource | null;
  termination_intent: InvocationTerminationIntent | null;
  provider_id: string;
  provider_session_id: string | null;
  started_at: number;
  terminal_at: number | null;
}

export type CleanTerminalSealPolicy = "seal" | "continue";
export type RunSealProjection =
  | { action: "continue" }
  | { action: "seal"; outcome: Exclude<Outcome, "none"> };

/**
 * The canonical run outcome projection. Only durable provider/server evidence
 * and a server-authored clean-turn policy may affect the result.
 *
 * A termination intent outranks a clean witness while the run is still open.
 * This is what makes stopping a BetweenTurns run deterministic even though its
 * preceding invocation already recorded a clean terminal.
 */
export function projectRunInvocationSeal(input: {
  terminalKind: InvocationTerminalKind | null;
  terminalSource: InvocationTerminalSource | null;
  terminationIntent: InvocationTerminationIntent | null;
  cleanTerminalPolicy: CleanTerminalSealPolicy;
  invocationDisappeared?: boolean;
}): RunSealProjection {
  if (input.terminalKind === "error") {
    return { action: "seal", outcome: "error" };
  }
  if (input.terminationIntent !== null) {
    return { action: "seal", outcome: "stopped" };
  }
  if (input.terminalKind === "clean") {
    return input.cleanTerminalPolicy === "seal"
      ? { action: "seal", outcome: "completed" }
      : { action: "continue" };
  }
  if (input.terminalKind === "lost" || input.terminalKind === "cancelled"
    || input.invocationDisappeared === true) {
    return { action: "seal", outcome: "interrupted" };
  }
  throw new Error("cannot project an in-flight invocation without disappearance evidence");
}

function byKey(db: Database.Database, runKey: string,
  providerGeneration: number): RunInvocationRow | null {
  return (db.prepare(`SELECT * FROM run_invocations
    WHERE run_key = ? AND provider_generation = ?`)
    .get(runKey, providerGeneration) as RunInvocationRow | undefined) ?? null;
}

export const getRunInvocation = byKey;

export function listRunInvocations(
  db: Database.Database,
  runKey: string,
): RunInvocationRow[] {
  return db.prepare(`SELECT * FROM run_invocations WHERE run_key = ?
    ORDER BY provider_generation`).all(runKey) as RunInvocationRow[];
}

/** Allocate and persist a provider generation before the harness is opened. */
export function startRunInvocation(db: Database.Database, input: {
  runKey: string;
  providerId: string;
  startedAt: number;
}): RunInvocationRow {
  return db.transaction(() => {
    const run = db.prepare(`SELECT ended_at, provider_generation FROM sessions
      WHERE session_key = ? AND work_item_id IS NOT NULL`).get(input.runKey) as
      { ended_at: number | null; provider_generation: number } | undefined;
    if (!run) throw new Error(`work-item run ${input.runKey} not found`);
    if (run.ended_at !== null) throw new Error(`work-item run ${input.runKey} is sealed`);
    const prior = db.prepare(`SELECT COALESCE(MAX(provider_generation), 0) AS generation
      FROM run_invocations WHERE run_key = ?`).get(input.runKey) as { generation: number };
    const generation = Math.max(run.provider_generation, prior.generation) + 1;
    db.prepare(`INSERT INTO run_invocations (
      run_key, provider_generation, sequence, phase, terminal_kind, terminal_source,
      termination_intent, provider_id, provider_session_id, started_at, terminal_at
    ) VALUES (?, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM run_invocations),
      'opening', NULL, NULL, NULL, ?, NULL, ?, NULL)`)
      .run(input.runKey, generation, input.providerId, input.startedAt);
    return byKey(db, input.runKey, generation)!;
  }).immediate();
}

/** Enrich opening evidence; initialization is not required to establish flight. */
export function markRunInvocationRunning(db: Database.Database, input: {
  runKey: string;
  providerGeneration: number;
  providerSessionId: string;
}): RunInvocationRow | null {
  return db.transaction(() => {
    db.prepare(`UPDATE run_invocations
      SET phase = 'running', provider_session_id = ?
      WHERE run_key = ? AND provider_generation = ?
        AND phase IN ('opening', 'running')`)
      .run(input.providerSessionId, input.runKey, input.providerGeneration);
    return byKey(db, input.runKey, input.providerGeneration);
  }).immediate();
}

/** Preserve the first operator/server intent before any process signal is sent. */
export function recordRunInvocationIntent(db: Database.Database, input: {
  runKey: string;
  providerGeneration: number;
  intent: InvocationTerminationIntent;
}): RunInvocationRow | null {
  return db.transaction(() => {
    db.prepare(`UPDATE run_invocations
      SET termination_intent = COALESCE(termination_intent, ?)
      WHERE run_key = ? AND provider_generation = ?`)
      .run(input.intent, input.runKey, input.providerGeneration);
    return byKey(db, input.runKey, input.providerGeneration);
  }).immediate();
}

/**
 * CAS the first terminal observation. When supplied, projection runs in the
 * same SQLite transaction and is skipped for stale/later observations.
 */
export function claimRunInvocationTerminal(db: Database.Database, input: {
  runKey: string;
  providerGeneration: number;
  terminalKind: InvocationTerminalKind;
  terminalSource: InvocationTerminalSource;
  terminalAt: number;
  applyProjection?: (invocation: RunInvocationRow) => void;
}): { claimed: boolean; invocation: RunInvocationRow | null } {
  return db.transaction(() => {
    const phase: InvocationPhase = input.terminalKind === "lost" ? "lost" : "terminal";
    const changed = db.prepare(`UPDATE run_invocations SET
      phase = ?, terminal_kind = ?, terminal_source = ?, terminal_at = ?
      WHERE run_key = ? AND provider_generation = ? AND terminal_kind IS NULL`)
      .run(phase, input.terminalKind, input.terminalSource, input.terminalAt,
        input.runKey, input.providerGeneration);
    const invocation = byKey(db, input.runKey, input.providerGeneration);
    if (changed.changes === 1 && invocation) input.applyProjection?.(invocation);
    return {
      claimed: changed.changes === 1,
      invocation,
    };
  }).immediate();
}

/**
 * Finalize an explicit termination while preserving an earlier witness. The
 * existing Phase-1 projection still runs transactionally even when CAS loses.
 */
export function finalizeRunInvocationTermination(db: Database.Database, input: {
  runKey: string;
  providerGeneration: number;
  terminalAt: number;
  applyProjection: (invocation: RunInvocationRow | null) => void;
}): { claimed: boolean; invocation: RunInvocationRow | null } {
  return db.transaction(() => {
    const changed = db.prepare(`UPDATE run_invocations SET
      phase = 'terminal', terminal_kind = 'cancelled',
      terminal_source = 'server', terminal_at = ?
      WHERE run_key = ? AND provider_generation = ? AND terminal_kind IS NULL`)
      .run(input.terminalAt, input.runKey, input.providerGeneration);
    const invocation = byKey(db, input.runKey, input.providerGeneration);
    input.applyProjection(invocation);
    return {
      claimed: changed.changes === 1,
      invocation,
    };
  }).immediate();
}
