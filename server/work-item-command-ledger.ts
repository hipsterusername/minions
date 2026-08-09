import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function workItemInputHash(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");
}

export function findCommandResult(db: Database.Database, input: {
  requestId: string; command: string; payload: unknown;
}): string | null | undefined {
  const row = db.prepare(`SELECT command, input_hash, result_key FROM work_item_commands
    WHERE request_id = ?`).get(input.requestId) as
    { command: string; input_hash: string; result_key: string | null } | undefined;
  if (!row) return undefined;
  if (row.command !== input.command || row.input_hash !== workItemInputHash(input.payload)) {
    throw new Error("idempotency request was reused with different input");
  }
  return row.result_key;
}

export function executeWorkItemCommand<T>(db: Database.Database, input: {
  requestId: string; workItemId: string; command: string; payload: unknown; at: number; resultKey?: string;
}, mutate: () => T): { idempotent: boolean; value: T | null; resultKey: string | null } {
  return db.transaction(() => {
    const hash = workItemInputHash(input.payload);
    const row = db.prepare(`SELECT work_item_id, command, input_hash
      , result_key FROM work_item_commands WHERE request_id = ?`).get(input.requestId) as
      { work_item_id: string; command: string; input_hash: string; result_key: string | null } | undefined;
    if (row) {
      if (row.work_item_id !== input.workItemId || row.command !== input.command || row.input_hash !== hash) {
        throw new Error("idempotency request was reused with different input");
      }
      return { idempotent: true, value: null, resultKey: row.result_key };
    }
    const value = mutate();
    db.prepare(`INSERT INTO work_item_commands
      (request_id, work_item_id, command, input_hash, result_key, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(input.requestId, input.workItemId, input.command, hash, input.resultKey ?? null, input.at);
    return { idempotent: false, value, resultKey: input.resultKey ?? null };
  }).immediate();
}
