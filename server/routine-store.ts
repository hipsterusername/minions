/**
 * Routine file storage.
 *
 * Routines live as one JSON file per routine at
 * `<projectPath>/.minions/routines/<id>.json`. This mirrors the
 * pattern set by `skills.json` in `project-store.ts` but uses one-file-per
 * because routines are coarser-grained, edited individually, and benefit
 * from independent diffs.
 *
 * The store is intentionally thin: it reads, writes, lists, and deletes.
 * Validation is delegated to `safeParseRoutine` from the shared schema —
 * malformed files are skipped during list operations rather than throwing,
 * matching the project-store's tolerance for hand-edited sidecar files.
 */

import fs from "node:fs";
import path from "node:path";
import {
  safeParseRoutine,
  type Routine,
} from "../shared/routines/types.ts";

const SIDECAR_DIR = ".minions";
const ROUTINES_DIR = "routines";

/** Absolute path to the routines folder for a project. */
export function routinesPath(projectPath: string): string {
  return path.join(projectPath, SIDECAR_DIR, ROUTINES_DIR);
}

/** Absolute path to one routine file. */
export function routineFilePath(projectPath: string, id: string): string {
  return path.join(routinesPath(projectPath), `${id}.json`);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Result of a list operation. Splits clean parses from malformed entries
 * so the UI can surface "3 routines, 1 invalid" without losing the good
 * ones to a single bad file.
 */
export interface ListRoutinesResult {
  routines: Routine[];
  invalid: { file: string; errors: { path: string; message: string }[] }[];
}

/**
 * List every routine in the project's sidecar. Missing folder = empty
 * result, not an error. Each `.json` file is parsed independently so one
 * bad file cannot poison the listing.
 */
export function listRoutines(projectPath: string): ListRoutinesResult {
  const dir = routinesPath(projectPath);
  if (!fs.existsSync(dir)) return { routines: [], invalid: [] };
  const entries = fs.readdirSync(dir);
  const routines: Routine[] = [];
  const invalid: ListRoutinesResult["invalid"] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(dir, entry);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch {
      invalid.push({
        file: entry,
        errors: [{ path: "", message: "could not read file" }],
      });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      invalid.push({
        file: entry,
        errors: [{ path: "", message: "invalid JSON" }],
      });
      continue;
    }
    const result = safeParseRoutine(parsed);
    if (result.ok) {
      routines.push(result.routine);
    } else {
      invalid.push({ file: entry, errors: result.errors });
    }
  }
  // Stable ordering by id so the UI list is deterministic.
  routines.sort((a, b) => a.id.localeCompare(b.id));
  return { routines, invalid };
}

/**
 * Load one routine by id. Returns `null` when missing or invalid — the
 * caller should treat both as "not available" rather than distinguish.
 * Use {@link loadRoutineByIdStrict} when you need the parse errors.
 */
export function loadRoutineById(
  projectPath: string,
  id: string,
): Routine | null {
  const result = loadRoutineByIdStrict(projectPath, id);
  return result.ok ? result.routine : null;
}

/** Strict variant — surfaces parse errors so callers can show them. */
export function loadRoutineByIdStrict(
  projectPath: string,
  id: string,
):
  | { ok: true; routine: Routine }
  | { ok: false; reason: "missing" | "invalid-json" | "schema"; errors?: { path: string; message: string }[] } {
  const file = routineFilePath(projectPath, id);
  if (!fs.existsSync(file)) return { ok: false, reason: "missing" };
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return { ok: false, reason: "missing" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  const result = safeParseRoutine(parsed);
  if (result.ok) return { ok: true, routine: result.routine };
  return { ok: false, reason: "schema", errors: result.errors };
}

/**
 * Save a routine to disk. Validates against the schema before writing —
 * the store is the only path through which routines reach the filesystem,
 * so this guarantees `.minions/routines/` never holds a structurally
 * invalid file produced by our own code.
 *
 * Stamps `updatedAt` on every write so the UI can sort by recency.
 */
export function saveRoutine(projectPath: string, routine: Routine): Routine {
  const result = safeParseRoutine(routine);
  if (!result.ok) {
    const detail = result.errors
      .map((e) => `${e.path || "(root)"}: ${e.message}`)
      .join("; ");
    throw new Error(`Cannot save invalid routine: ${detail}`);
  }
  const stamped: Routine = {
    ...result.routine,
    updatedAt: new Date().toISOString(),
  };
  const dir = routinesPath(projectPath);
  ensureDir(dir);
  const file = routineFilePath(projectPath, routine.id);
  fs.writeFileSync(file, JSON.stringify(stamped, null, 2));
  return stamped;
}

/**
 * Delete a routine file. Returns true when a file was removed, false when
 * it didn't exist (idempotent).
 */
export function deleteRoutine(projectPath: string, id: string): boolean {
  const file = routineFilePath(projectPath, id);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}
