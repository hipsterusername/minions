import crypto from "node:crypto";
import type Database from "better-sqlite3";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export class IntegrationIdempotencyMismatchError extends Error {}

/** Durable lost-response replay for every externally invoked lineage mutation. */
export function executeIntegrationCommand<T>(db: Database.Database, input: {
  requestId: string; command: string; payload: unknown; at: number;
}, execute: () => T): { value: T; replayed: boolean } {
  return db.transaction(() => {
    const hash = crypto.createHash("sha256").update(stable(input.payload)).digest("hex");
    const prior = db.prepare(`SELECT command,input_hash,result_json FROM worktree_integration_commands
      WHERE request_id=?`).get(input.requestId) as { command: string; input_hash: string; result_json: string } | undefined;
    if (prior) {
      if (prior.command !== input.command || prior.input_hash !== hash)
        throw new IntegrationIdempotencyMismatchError("integration requestId was reused with different input");
      return { value: JSON.parse(prior.result_json) as T, replayed: true };
    }
    const value = execute();
    db.prepare(`INSERT INTO worktree_integration_commands
      (request_id,command,input_hash,result_json,recorded_at) VALUES (?, ?, ?, ?, ?)`)
      .run(input.requestId, input.command, hash, JSON.stringify(value ?? null), input.at);
    return { value, replayed: false };
  }).immediate();
}
