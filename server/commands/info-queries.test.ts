/**
 * info-queries — read-only queries split into two groups after Phase A:
 *
 * Run-dependent (getContextUsage, getMcpServerStatus): routed through
 * host.runControl — tests use setRunControl / fakeRunControl.
 *
 * Run-independent (getSupportedModels, getSupportedCommands,
 * getSupportedAgents, getAccountInfo): routed through harness.staticInfo()
 * — tests set host.harnessName = "echo" to use EchoHarness.staticInfo().
 */
import { describe, expect, it, vi } from "vitest";
import {
  getAccountInfo,
  getContextUsage,
  getMcpServerStatus,
  getSupportedAgents,
  getSupportedCommands,
  getSupportedModels,
} from "./info-queries.ts";
import { setup, cmd, fakeRunControl } from "./test-harness.ts";
import type { CommandHandler } from "./types.ts";

// ── Run-dependent queries ─────────────────────────────────────

interface RunDepCase {
  command: string;
  handler: CommandHandler;
  method: "getContextUsage" | "mcpServerStatus";
  payload: unknown;
  field: string;
}

const RUN_DEP_CASES: ReadonlyArray<RunDepCase> = [
  {
    command: "get_context_usage",
    handler: getContextUsage,
    method: "getContextUsage",
    payload: { tokens: 1000, max: 200_000 },
    field: "usage",
  },
  {
    command: "get_mcp_server_status",
    handler: getMcpServerStatus,
    method: "mcpServerStatus",
    payload: [{ name: "render", status: "ready" }],
    field: "servers",
  },
];

describe.each(RUN_DEP_CASES)(
  "info-queries / $command (run-dependent)",
  ({ command, handler, method, payload, field }) => {
    it("forwards the runControl response back as a successful control_response", async () => {
      const h = setup();
      h.setRunControl(fakeRunControl({ [method]: vi.fn(async () => payload) }));

      handler(h.ctx, cmd({ type: command as never }), h.ws);

      await Promise.resolve();
      await Promise.resolve();

      expect(h.wsSent).toHaveLength(1);
      const env = h.wsSent[0]!;
      expect(env["type"]).toBe("control_response");
      expect(env["command"]).toBe(command);
      expect(env["success"]).toBe(true);
      expect(env[field]).toEqual(payload);
    });

    it("replies with 'No active query' when runControl is null", () => {
      const h = setup();
      // host.runControl stays null/undefined.
      handler(h.ctx, cmd({ type: command as never }), h.ws);

      expect(h.wsSent).toHaveLength(1);
      expect(h.wsSent[0]!["success"]).toBe(false);
      expect(h.wsSent[0]!["error"]).toContain("No active query");
    });

    it("replies 'unsupported by harness' when the method is absent on runControl", () => {
      const h = setup();
      h.host.harnessName = "echo";
      // runControl with only abort() — no optional method
      h.setRunControl({ abort() {} });

      handler(h.ctx, cmd({ type: command as never }), h.ws);

      expect(h.wsSent[0]!["success"]).toBe(false);
      expect(h.wsSent[0]!["error"]).toMatch(/"echo"/);
    });

    it("propagates runControl rejection as control_error", async () => {
      const h = setup();
      h.setRunControl(fakeRunControl({
        [method]: vi.fn(async () => { throw new Error("model is offline"); }),
      }));

      handler(h.ctx, cmd({ type: command as never }), h.ws);

      await Promise.resolve();
      await Promise.resolve();

      expect(h.wsSent[0]!["success"]).toBe(false);
      expect(h.wsSent[0]!["error"]).toBe("model is offline");
    });
  },
);

// ── Run-independent queries (harness.staticInfo()) ────────────

interface StaticInfoCase {
  command: string;
  handler: CommandHandler;
  field: string;
}

const STATIC_INFO_CASES: ReadonlyArray<StaticInfoCase> = [
  { command: "get_supported_models", handler: getSupportedModels, field: "models" },
  { command: "get_supported_commands", handler: getSupportedCommands, field: "commands" },
  { command: "get_supported_agents", handler: getSupportedAgents, field: "agents" },
  { command: "get_account_info", handler: getAccountInfo, field: "account" },
];

describe.each(STATIC_INFO_CASES)(
  "info-queries / $command (run-independent via staticInfo)",
  ({ command, handler, field }) => {
    it("returns success with the staticInfo field even when no run is live", () => {
      const h = setup();
      // Use echo harness — it has a complete staticInfo() implementation.
      h.host.harnessName = "echo";

      handler(h.ctx, cmd({ type: command as never }), h.ws);

      expect(h.wsSent).toHaveLength(1);
      const env = h.wsSent[0]!;
      expect(env["type"]).toBe("control_response");
      expect(env["command"]).toBe(command);
      expect(env["success"]).toBe(true);
      expect(env[field]).toBeDefined();
    });

    it("works whether or not a runControl is attached (no-run-required)", () => {
      const h = setup();
      h.host.harnessName = "echo";
      // Even with an active runControl, the static query just reads staticInfo.
      h.setRunControl({ abort() {} });

      handler(h.ctx, cmd({ type: command as never }), h.ws);

      expect(h.wsSent[0]!["success"]).toBe(true);
    });
  },
);

// ── Session lookup errors ─────────────────────────────────────

describe("info-queries — session lookup", () => {
  it("emits a global error when sessionKey is missing", () => {
    const h = setup();
    getContextUsage(
      h.ctx,
      cmd({ type: "get_context_usage" as never, sessionKey: undefined }),
      h.ws,
    );
    expect(h.wsSent).toHaveLength(1);
    expect(h.wsSent[0]!["type"]).toBe("error");
    expect(h.wsSent[0]!["topic"]).toBe("global");
  });

  it("emits a session-scoped error when the session is unknown", () => {
    const h = setup();
    getContextUsage(
      h.ctx,
      cmd({ type: "get_context_usage" as never, sessionKey: "unknown" }),
      h.ws,
    );
    expect(h.wsSent).toHaveLength(1);
    expect(h.wsSent[0]!["type"]).toBe("error");
    expect(h.wsSent[0]!["topic"]).toBe("session:unknown");
  });
});
