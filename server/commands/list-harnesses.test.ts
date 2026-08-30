
import { describe, expect, it, vi } from "vitest";
import { listHarnesses } from "./list-harnesses.ts";
import { setup, cmd } from "../../tests/support/server-command-harness.ts";

vi.mock("../harness/readiness.ts", () => ({
  getHarnessReadiness: async () => ({
    schemaVersion: 1,
    checkedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:00:30.000Z",
    ready: false,
    readyHarnesses: [],
    harnesses: [],
  }),
}));

// Side-effect imports register harnesses for the registry the handler reads.
import "../harness/claude/index.ts";
import "../harness/echo/index.ts";
import "../harness/codex/index.ts";
import "../harness/opencode/index.ts";
import "../harness/pi/index.ts";

describe("listHarnesses", () => {
  it("emits a global harness_list envelope including registered harness metadata", async () => {
    const h = setup();

    await listHarnesses(h.ctx, cmd({ type: "list_harnesses" }), h.ws);

    expect(h.wsSent).toHaveLength(1);
    const env = h.wsSent[0]!;
    expect(env["topic"]).toBe("global");
    expect(env["type"]).toBe("harness_list");

    const harnesses = env["harnesses"] as Array<{
      name: string;
      capabilities: Record<string, boolean>;
      models: Array<{ id: string; label: string }>;
      builtInTools: string[];
      account: { provider: string };
    }>;
    const byName = new Map(harnesses.map((entry) => [entry.name, entry]));

    const claude = byName.get("claude");
    expect(claude).toBeDefined();
    expect(claude!.capabilities["thinking"]).toBe(true);
    expect(claude!.capabilities["mcp"]).toBe(true);
    expect(claude!.models.length).toBeGreaterThan(0);
    expect(claude!.builtInTools).toContain("Read");
    expect(claude!.account.provider).toBe("claude");

    const codex = byName.get("codex");
    expect(codex).toBeDefined();
    expect(codex!.capabilities["thinking"]).toBe(true);
    expect(codex!.capabilities["mcp"]).toBe(true);
    expect(codex!.models.map((m) => m.id)).toContain("gpt-5.6-sol");
    expect(codex!.models.map((m) => m.id)).toContain("gpt-5.6-terra");
    expect(codex!.models.map((m) => m.id)).toContain("gpt-5.6-luna");
    expect(codex!.account.provider).toBe("openai");

    const opencode = byName.get("opencode");
    expect(opencode).toBeDefined();
    expect(opencode!.capabilities["mcp"]).toBe(true);
    expect(opencode!.account.provider).toBe("opencode");

    const pi = byName.get("pi");
    expect(pi).toBeDefined();
    expect(pi!.capabilities["mcp"]).toBe(false);
    expect(pi!.capabilities["partialMessages"]).toBe(true);
    expect(pi!.account.provider).toBe("pi");

    // Echo is a test-only placeholder harness and must not be exposed to the
    // client — see HIDDEN_HARNESSES in list-harnesses.ts.
    expect(byName.has("echo")).toBe(false);
  });

  it("does not require a session to be present", async () => {
    const h = setup();
    // Drain the seeded session so the registry is empty.
    (h.ctx.registry as unknown as { map: Map<string, unknown> }).map.clear();

    await listHarnesses(h.ctx, cmd({ type: "list_harnesses" }), h.ws);

    expect(h.wsSent).toHaveLength(1);
    const harnesses = h.wsSent[0]!["harnesses"] as Array<{ name: string }>;
    expect(harnesses.length).toBeGreaterThan(0);
  });
});
