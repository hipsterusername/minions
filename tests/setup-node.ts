import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Commit hooks inherit checkout overrides from Git. Fixture repositories must
// resolve their own metadata, especially worktrees whose .git is a file.
for (const key of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) {
  delete process.env[key];
}

// Run in both Vitest projects before each file imports application modules.
// A shared runner-level directory allows unrelated suites to contaminate the
// registry and session DB.
// Individual tests can still override MINIONS_HOME to exercise specific paths.
const testMinionsHome = mkdtempSync(join(tmpdir(), "minions-vitest-"));
process.env["MINIONS_HOME"] = testMinionsHome;
// This override takes precedence over MINIONS_HOME in session persistence.
// Drop the inherited value so fixtures can still test MINIONS_HOME routing.
delete process.env["MINIONS_SERVER_DB"];
process.env["DB_PATH"] = join(testMinionsHome, "canvas.db");
delete process.env["MINIONS_ARTIFACTS_DIR"];

afterAll(() => {
  // Vitest owns this worker's environment. Never restore live storage paths:
  // an asynchronous session finalizer may still persist after suite teardown.
  rmSync(testMinionsHome, { recursive: true, force: true });
});
