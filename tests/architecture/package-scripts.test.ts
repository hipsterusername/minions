/**
 * Contract — top-level dev-loop script wiring in package.json.
 *
 * `pnpm start` must be the NON-BLOCKING background launcher (scripts/start.mjs),
 * so it detaches and returns the terminal immediately. The foreground,
 * log-streaming supervisor lives under `pnpm dev` (scripts/run.mjs).
 *
 * These are behavioural guarantees users depend on; this test fails loudly if
 * the two get swapped back.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

const scripts: Record<string, string> = JSON.parse(
  readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
).scripts;

describe("package.json dev-loop scripts", () => {
  it("`start` is the non-blocking background launcher (scripts/start.mjs)", () => {
    expect(
      scripts["start"],
      "`pnpm start` must launch the background service so it returns the " +
        "terminal immediately. It should invoke scripts/start.mjs, not the " +
        "foreground supervisor scripts/run.mjs.",
    ).toBe("node scripts/start.mjs start");
  });

  it("`dev` is the foreground supervisor (scripts/run.mjs)", () => {
    expect(scripts["dev"]).toBe("node scripts/run.mjs dev");
  });

  it("background lifecycle commands all target scripts/start.mjs", () => {
    expect(scripts["stop"]).toBe("node scripts/start.mjs stop");
    expect(scripts["restart"]).toBe("node scripts/start.mjs restart");
    expect(scripts["status"]).toBe("node scripts/start.mjs status");
  });

  it("does not keep a redundant `serve` alias for the background launcher", () => {
    // `start` now owns background mode; a second alias would be a compat shim.
    expect(scripts["serve"]).toBeUndefined();
  });
});
