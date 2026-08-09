import type Database from "better-sqlite3";

export type RunRecoveryAction = "resume" | "interrupt" | "stop";

export interface RunRecoveryWitness {
  action: RunRecoveryAction;
  providerGeneration: number | null;
  terminationIntent: string | null;
  legacy: boolean;
}

interface InvocationWitnessRow {
  provider_generation: number;
  phase: string;
  terminal_kind: string | null;
  termination_intent: string | null;
}

function latestInvocation(
  db: Database.Database,
  runKey: string,
): InvocationWitnessRow | null {
  return (db.prepare(`
    SELECT provider_generation, phase, terminal_kind, termination_intent
    FROM run_invocations
    WHERE run_key = ?
    ORDER BY provider_generation DESC
    LIMIT 1
  `).get(runKey) as InvocationWitnessRow | undefined) ?? null;
}

/**
 * Decide whether an open run was safely between turns when the process died.
 * Rows predating the invocation ledger deliberately retain conservative
 * interrupted recovery.
 */
export function inspectRunRecoveryWitness(
  db: Database.Database,
  runKey: string,
): RunRecoveryWitness {
  const invocation = latestInvocation(db, runKey);
  if (!invocation) {
    return {
      action: "interrupt",
      providerGeneration: null,
      terminationIntent: null,
      legacy: true,
    };
  }
  if (invocation.termination_intent !== null) {
    return {
      action: "stop",
      providerGeneration: invocation.provider_generation,
      terminationIntent: invocation.termination_intent,
      legacy: false,
    };
  }
  if (invocation.phase === "terminal" && invocation.terminal_kind === "clean") {
    return {
      action: "resume",
      providerGeneration: invocation.provider_generation,
      terminationIntent: null,
      legacy: false,
    };
  }
  return {
    action: "interrupt",
    providerGeneration: invocation.provider_generation,
    terminationIntent: null,
    legacy: false,
  };
}

/**
 * Persist boot's terminal observation for an invocation that had no terminal
 * row. The caller owns the surrounding transaction that seals the run.
 */
export function recordBootRecoveryWitness(
  db: Database.Database,
  runKey: string,
  witness: RunRecoveryWitness,
  at: number,
): void {
  if (witness.providerGeneration === null || witness.action === "resume") return;
  if (witness.action === "stop") {
    db.prepare(`
      UPDATE run_invocations
      SET phase = 'terminal', terminal_kind = 'cancelled',
        terminal_source = 'boot', terminal_at = ?
      WHERE run_key = ? AND provider_generation = ?
        AND terminal_kind IS NULL AND termination_intent IS NOT NULL
    `).run(at, runKey, witness.providerGeneration);
    return;
  }
  db.prepare(`
    UPDATE run_invocations
    SET phase = 'lost', terminal_kind = 'lost',
      terminal_source = 'boot', terminal_at = ?
    WHERE run_key = ? AND provider_generation = ?
      AND terminal_kind IS NULL AND termination_intent IS NULL
  `).run(at, runKey, witness.providerGeneration);
}
