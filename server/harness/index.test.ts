/**
 * Unit tests for the harness registry (server/harness/index.ts).
 *
 * The registry is a module-level singleton. Tests use unique names (via a
 * counter) to avoid cross-test pollution without needing a reset mechanism.
 *
 * Coverage:
 *   - Registration and retrieval round-trip
 *   - Multiple harnesses coexist independently
 *   - Duplicate registration overwrites cleanly
 *   - Unknown name throws with a descriptive, actionable message
 *   - registeredHarnessNames() reflects registered entries
 */

import { describe, it, expect } from "vitest";
import type { AgentHarness, HarnessCapabilities, NormalizedToolDef } from "./types.ts";
import { registerHarness, getHarness, registeredHarnessNames } from "./index.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

const STUB_CAPABILITIES: HarnessCapabilities = {
  thinking: false,
  promptCaching: false,
  mcp: false,
  permissionPrompts: false,
  resume: false,
  partialMessages: false,
};

function makeStubHarness(name: string): AgentHarness {
  return {
    name,
    capabilities: { ...STUB_CAPABILITIES },
    start(): AsyncIterable<never> {
      throw new Error(`${name}.start() not implemented in stub`);
    },
    abort() {},
    registerTools(_defs: NormalizedToolDef[]) {},
    resolveModel() {
      return null;
    },
  };
}

// Use a module-level counter so every test gets a fresh unique name and the
// singleton registry accumulates without cross-test interference.
let seq = 0;
function uid(label: string): string {
  return `${label}-${(seq += 1)}`;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("harness registry", () => {
  describe("registerHarness + getHarness", () => {
    it("retrieves the harness by the name it was registered with", () => {
      const name = uid("alpha");
      const harness = makeStubHarness(name);
      registerHarness(harness);
      expect(getHarness(name)).toBe(harness);
    });

    it("stores multiple harnesses independently", () => {
      const nameA = uid("multi");
      const nameB = uid("multi");
      const a = makeStubHarness(nameA);
      const b = makeStubHarness(nameB);
      registerHarness(a);
      registerHarness(b);
      expect(getHarness(nameA)).toBe(a);
      expect(getHarness(nameB)).toBe(b);
    });

    it("overwrites an existing registration when the same name is reused", () => {
      const name = uid("overwrite");
      const first = makeStubHarness(name);
      const second = makeStubHarness(name);
      registerHarness(first);
      registerHarness(second);
      expect(getHarness(name)).toBe(second);
    });
  });

  describe("getHarness — unknown name", () => {
    it("throws for an unregistered name", () => {
      expect(() => getHarness("__not-registered-xyz__")).toThrow(
        /Unknown harness "__not-registered-xyz__"/,
      );
    });

    it("includes the offending name in the error", () => {
      const badName = uid("bad-name");
      expect(() => getHarness(badName)).toThrow(new RegExp(`Unknown harness "${badName}"`));
    });

    it("names registered harnesses in the error message", () => {
      const name = uid("visible-in-error");
      registerHarness(makeStubHarness(name));
      // A *different* unknown name is looked up; the error should list `name`.
      expect(() => getHarness("__totally-different__")).toThrow(new RegExp(name));
    });

    it("error message always contains 'Registered harnesses:'", () => {
      expect(() => getHarness("__sentinel__")).toThrow(/Registered harnesses:/);
    });

    it("error message always contains the import hint", () => {
      expect(() => getHarness("__sentinel-2__")).toThrow(
        /Import the harness module before calling getHarness/,
      );
    });
  });

  describe("registeredHarnessNames", () => {
    it("includes a name that was just registered", () => {
      const name = uid("names-check");
      registerHarness(makeStubHarness(name));
      expect(registeredHarnessNames()).toContain(name);
    });

    it("returns an Array, not a Map iterator or Set", () => {
      expect(Array.isArray(registeredHarnessNames())).toBe(true);
    });

    it("reflects multiple registrations", () => {
      const a = uid("multi-names");
      const b = uid("multi-names");
      registerHarness(makeStubHarness(a));
      registerHarness(makeStubHarness(b));
      const names = registeredHarnessNames();
      expect(names).toContain(a);
      expect(names).toContain(b);
    });
  });
});
