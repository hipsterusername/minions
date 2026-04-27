/**
 * Colocated test for the built-in skill registration.
 *
 * The module under test performs a side-effect call to
 * `registerBuiltinSkills()` on import. This test pins the behaviour:
 * after the module loads, every documented built-in skill must be in
 * the registry and `registerBuiltinSkills` must be idempotent.
 *
 * This is the regression net for the registry/`registerSkill` arity
 * drift fix — previously each call passed a phantom `{ builtIn: true }`
 * second argument that the registry never accepted, so the calls
 * silently type-errored without any test catching the rot.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { clearSkills, getAllSkills, getSkill } from "../registry.ts";
import { registerBuiltinSkills } from "./index.ts";

const EXPECTED_BUILTIN_IDS = [
  "code-review",
  "test-generator",
  "refactor",
  "documentation",
  "debug",
  "explain",
  "commit",
  "frontend-design",
  "simplify",
  "performance",
  "security-audit",
  "architect",
  "api-design",
] as const;

describe("registerBuiltinSkills", () => {
  beforeEach(() => {
    clearSkills();
    registerBuiltinSkills();
  });

  it("registers every documented built-in skill by id", () => {
    for (const id of EXPECTED_BUILTIN_IDS) {
      expect(getSkill(id), `expected built-in skill "${id}" to be registered`)
        .toBeDefined();
    }
  });

  it("registers exactly the documented set (no extras, no gaps)", () => {
    const ids = getAllSkills().map((s) => s.id).sort();
    expect(ids).toEqual([...EXPECTED_BUILTIN_IDS].sort());
  });

  it("is idempotent — re-running does not duplicate entries", () => {
    const before = getAllSkills().length;
    registerBuiltinSkills();
    registerBuiltinSkills();
    expect(getAllSkills().length).toBe(before);
  });
});
