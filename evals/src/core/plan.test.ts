import { mkdir, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createImmutablePlan, scheduleCells, validateTaskManifest } from "./index.js";
import { taskManifest } from "../../tests/support/fixtures.js";

describe("planning", () => {
  it("makes an immutable deterministic schedule", () => {
    const plan = createImmutablePlan({ schemaVersion: 1, experimentId: "pilot", taskRevisions: { "pagination-simple": "r1" }, adapterConfigs: [{ schemaVersion: 1, adapterId: "fixture", settings: {}, requiredCapabilities: [] }], repetitions: 2, schedulingSeed: "seed", limits: { aggregateTokenCap: 100, storageBytes: 100 }, provenance: { evaluatorRevision: "r1", implementationDigest: "a".repeat(64), createdAt: "2026-01-01T00:00:00.000Z" } }, [taskManifest], { "pagination-simple": "fixture-seed" });
    expect(scheduleCells(plan, [taskManifest], { "pagination-simple": "fixture-seed" })).toEqual(scheduleCells(plan, [taskManifest], { "pagination-simple": "fixture-seed" }));
    expect(Object.isFrozen(plan)).toBe(true);
  });
  it("rejects task asset symlinks that escape the relevant root", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-task-")); await mkdir(join(root, "public")); await writeFile(join(root, "public", "prompt.md"), "prompt"); await writeFile(join(root, "public", "fixture.json"), "{}"); await writeFile(join(root, "grader.json"), "{}"); await symlink("/etc/passwd", join(root, "public", "prompt-link.md"));
    await expect(validateTaskManifest({ ...taskManifest, promptFile: "public/prompt-link.md", fixture: { ...taskManifest.fixture, configFile: "public/fixture.json" } }, { taskRoot: root, publicRoot: join(root, "public") })).rejects.toThrow(/symlink/);
  });
});
