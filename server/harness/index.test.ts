
import { describe, it, expect } from "vitest";
import type { AgentHarness, HarnessCapabilities, NormalizedToolDef } from "./types.ts";
import { registerHarness, getHarness, registeredHarnessNames } from "./index.ts";

const STUB_CAPABILITIES: HarnessCapabilities = {
  mutationInterception: "none",
  thinking: false,
  promptCaching: false,
  mcp: false,
  permissionPrompts: false,
  resume: false,
  partialMessages: false,
  builtInFilesystem: false,
};

function makeStubHarness(name: string): AgentHarness {
  return {
    name,
    exposure: "test",
    capabilities: { ...STUB_CAPABILITIES },
    builtInTools: [],
    async checkReadiness() {
      return { state: "ready", runtime: { available: true, source: "sdk_bundled" }, auth: { authenticated: true, source: "unknown" } };
    },
    start() {
      return {
        events: (async function* () {})(),
        control: { abort() {} },
      };
    },
    registerTools(_defs: Record<string, NormalizedToolDef[]>) {},
    resolveModel() {
      return null;
    },
    staticInfo() {
      return {
        models: [],
        commands: [],
        agents: [],
        account: { provider: name },
      };
    },
  };
}

// Use a module-level counter so every test gets a fresh unique name and the
// singleton registry accumulates without cross-test interference.
let seq = 0;
function uid(label: string): string {
  return `${label}-${(seq += 1)}`;
}

describe("harness registry", () => {
  describe("registerHarness + getHarness", () => {
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
    it("rejects unknown names with the requested name, registered choices, and import hint", () => {
      const name = uid("visible-in-error");
      const badName = uid("bad-name");
      registerHarness(makeStubHarness(name));
      expect(() => getHarness(badName)).toThrow(
        new RegExp(`Unknown harness "${badName}"\\. Registered harnesses: .*${name}.*Import the harness module before calling getHarness`),
      );
    });
  });

  describe("registeredHarnessNames", () => {
    it("returns an array reflecting multiple registrations", () => {
      const a = uid("multi-names");
      const b = uid("multi-names");
      registerHarness(makeStubHarness(a));
      registerHarness(makeStubHarness(b));
      const names = registeredHarnessNames();
      expect(Array.isArray(names)).toBe(true);
      expect(names).toContain(a);
      expect(names).toContain(b);
    });
  });
});
