import { describe, expect, it, vi } from "vitest";
import {
  getAccountInfo,
  getContextUsage,
  getMcpServerStatus,
  getProviderUsageReport,
  getUsageReport,
  getSupportedAgents,
  getSupportedCommands,
  getSupportedModels,
} from "./info-queries.ts";
import { setup, cmd, fakeRunControl } from "../../tests/support/server-command-harness.ts";
import type { CommandHandler } from "./types.ts";
import "../harness/codex/index.ts";

interface RunDepCase {
  command: string;
  handler: CommandHandler;
  method: "getContextUsage" | "getUsageReport" | "mcpServerStatus";
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
    command: "get_usage_report",
    handler: getUsageReport,
    method: "getUsageReport",
    payload: {
      subscription_type: "pro",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42, resets_at: "2026-07-03T16:00:00.000Z" },
      },
    },
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

describe("info-queries / get_provider_usage_report", () => {
  it("uses the newest live matching harness runControl when one is available", async () => {
    const h = setup();
    h.host.harnessName = "claude";
    h.host.bufferEvent({
      type: "sdk_event",
      sessionKey: "leader-1",
      event: { kind: "done", reason: "completed" },
      timestamp: 10,
    });
    h.setRunControl(fakeRunControl({
      getUsageReport: vi.fn(async () => ({
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 67, resets_at: "2026-07-03T16:00:00.000Z" },
        },
      })),
    }));

    getProviderUsageReport(
      h.ctx,
      cmd({ type: "get_provider_usage_report", harness: "claude" }),
      h.ws,
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(h.wsSent).toHaveLength(1);
    expect(h.wsSent[0]).toMatchObject({
      type: "control_response",
      command: "get_provider_usage_report",
      success: true,
      provider: "claude",
      sessionKey: "leader-1",
    });
    expect(h.wsSent[0]?.["usage"]).toMatchObject({ rate_limits_available: true });
  });

  it("falls back to a run-independent harness usage report when supported", async () => {
    const h = setup();

    getProviderUsageReport(
      h.ctx,
      cmd({ type: "get_provider_usage_report", harness: "codex" }),
      h.ws,
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(h.wsSent).toHaveLength(1);
    expect(h.wsSent[0]).toMatchObject({
      type: "control_response",
      command: "get_provider_usage_report",
      success: true,
      provider: "codex",
    });
    expect(h.wsSent[0]?.["usage"]).toMatchObject({
      provider: "openai",
      rate_limits_available: false,
      rate_limits: null,
    });
  });

  it("returns a clear error when the provider has no live usage report", () => {
    const h = setup();

    getProviderUsageReport(
      h.ctx,
      cmd({ type: "get_provider_usage_report", harness: "claude" }),
      h.ws,
    );

    expect(h.wsSent).toHaveLength(1);
    expect(h.wsSent[0]).toMatchObject({
      type: "control_response",
      command: "get_provider_usage_report",
      success: false,
      provider: "claude",
    });
    expect(h.wsSent[0]?.["error"]).toContain("No live claude query");
  });
});

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
