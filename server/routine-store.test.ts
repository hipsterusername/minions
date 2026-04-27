/**
 * Tests for the routine file store. Uses a fresh temp directory per test
 * so no global state leaks across runs.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deleteRoutine,
  listRoutines,
  loadRoutineById,
  loadRoutineByIdStrict,
  routineFilePath,
  routinesPath,
  saveRoutine,
} from "./routine-store.ts";
import { parseRoutine, type Routine } from "../shared/routines/types.ts";

function makeRoutine(over: Partial<Routine> = {}): Routine {
  const base = parseRoutine({
    id: "demo",
    name: "Demo",
    phases: [
      {
        id: "p1",
        label: "Phase 1",
        steps: [{ id: "s1", label: "Step 1", routinePrompt: "Go." }],
      },
    ],
  });
  return { ...base, ...over };
}

describe("routine-store", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "routine-store-"));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  describe("listRoutines", () => {
    it("returns empty when the routines folder does not exist", () => {
      expect(listRoutines(projectDir)).toEqual({ routines: [], invalid: [] });
    });

    it("returns saved routines sorted by id", () => {
      saveRoutine(projectDir, makeRoutine({ id: "zulu", name: "Z" }));
      saveRoutine(projectDir, makeRoutine({ id: "alpha", name: "A" }));
      saveRoutine(projectDir, makeRoutine({ id: "mike", name: "M" }));
      const result = listRoutines(projectDir);
      expect(result.routines.map((r) => r.id)).toEqual([
        "alpha",
        "mike",
        "zulu",
      ]);
      expect(result.invalid).toEqual([]);
    });

    it("ignores non-json files in the routines folder", () => {
      saveRoutine(projectDir, makeRoutine());
      fs.writeFileSync(
        path.join(routinesPath(projectDir), "README.md"),
        "notes",
      );
      const result = listRoutines(projectDir);
      expect(result.routines).toHaveLength(1);
    });

    it("surfaces invalid JSON without losing valid siblings", () => {
      saveRoutine(projectDir, makeRoutine({ id: "good" }));
      fs.writeFileSync(
        path.join(routinesPath(projectDir), "bad.json"),
        "{ not valid json",
      );
      const result = listRoutines(projectDir);
      expect(result.routines.map((r) => r.id)).toEqual(["good"]);
      expect(result.invalid).toHaveLength(1);
      expect(result.invalid[0]!.file).toBe("bad.json");
      expect(result.invalid[0]!.errors[0]!.message).toBe("invalid JSON");
    });

    it("surfaces schema-invalid routines with structured errors", () => {
      saveRoutine(projectDir, makeRoutine({ id: "good" }));
      fs.writeFileSync(
        path.join(routinesPath(projectDir), "schema-bad.json"),
        JSON.stringify({ id: "Bad", name: "X", phases: [] }),
      );
      const result = listRoutines(projectDir);
      expect(result.routines).toHaveLength(1);
      expect(result.invalid).toHaveLength(1);
      expect(result.invalid[0]!.errors.length).toBeGreaterThan(0);
    });
  });

  describe("loadRoutineById", () => {
    it("returns null when the file does not exist", () => {
      expect(loadRoutineById(projectDir, "ghost")).toBeNull();
    });

    it("returns the routine when present and valid", () => {
      saveRoutine(projectDir, makeRoutine({ id: "real" }));
      const got = loadRoutineById(projectDir, "real");
      expect(got).not.toBeNull();
      expect(got!.id).toBe("real");
    });
  });

  describe("loadRoutineByIdStrict", () => {
    it("distinguishes missing vs invalid-json vs schema failures", () => {
      // missing
      expect(loadRoutineByIdStrict(projectDir, "ghost")).toEqual({
        ok: false,
        reason: "missing",
      });
      // invalid JSON
      fs.mkdirSync(routinesPath(projectDir), { recursive: true });
      fs.writeFileSync(routineFilePath(projectDir, "bad-json"), "{");
      const r1 = loadRoutineByIdStrict(projectDir, "bad-json");
      expect(r1.ok).toBe(false);
      if (!r1.ok) expect(r1.reason).toBe("invalid-json");
      // schema failure
      fs.writeFileSync(
        routineFilePath(projectDir, "bad-schema"),
        JSON.stringify({ id: "x" }),
      );
      const r2 = loadRoutineByIdStrict(projectDir, "bad-schema");
      expect(r2.ok).toBe(false);
      if (!r2.ok) {
        expect(r2.reason).toBe("schema");
        expect(r2.errors).toBeDefined();
      }
    });
  });

  describe("saveRoutine", () => {
    it("writes a routine and stamps updatedAt", () => {
      const before = Date.now();
      const saved = saveRoutine(projectDir, makeRoutine());
      const after = Date.now();
      expect(saved.updatedAt).toBeDefined();
      const ts = Date.parse(saved.updatedAt!);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    it("creates the routines folder on first save", () => {
      expect(fs.existsSync(routinesPath(projectDir))).toBe(false);
      saveRoutine(projectDir, makeRoutine());
      expect(fs.existsSync(routinesPath(projectDir))).toBe(true);
    });

    it("round-trips a routine through disk unchanged (modulo updatedAt)", () => {
      const original = makeRoutine();
      saveRoutine(projectDir, original);
      const loaded = loadRoutineById(projectDir, original.id)!;
      // Strip the field saveRoutine adds so the comparison is meaningful.
      const { updatedAt: _u, ...loadedRest } = loaded;
      expect(loadedRest).toEqual(original);
    });

    it("rejects an invalid routine instead of writing it", () => {
      // Cast around the type to feed a structurally invalid value.
      const bogus = { ...makeRoutine(), phases: [] } as unknown as Routine;
      expect(() => saveRoutine(projectDir, bogus)).toThrow(
        /invalid routine/i,
      );
      expect(listRoutines(projectDir).routines).toHaveLength(0);
    });
  });

  describe("deleteRoutine", () => {
    it("removes a present routine and returns true", () => {
      saveRoutine(projectDir, makeRoutine({ id: "doomed" }));
      expect(deleteRoutine(projectDir, "doomed")).toBe(true);
      expect(loadRoutineById(projectDir, "doomed")).toBeNull();
    });

    it("returns false when the routine does not exist", () => {
      expect(deleteRoutine(projectDir, "ghost")).toBe(false);
    });
  });
});
