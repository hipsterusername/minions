/**
 * info-queries — six read-only queries that delegate to the SDK
 * `query()` handle. They share the `runQueryOp` helper, so a parameterised
 * test (per §5.9) covers all six without three-times duplication.
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
import { setup, cmd, fakeQueryHandle } from "./test-harness.ts";
import type { CommandHandler } from "./types.ts";

interface InfoQueryCase {
  command: string;
  handler: CommandHandler;
  /** Method invoked on the SDK queryHandle. */
  method: string;
  /** Value the handle returns. */
  payload: unknown;
  /** Field on the control_response that carries the payload. */
  field: string;
}

const CASES: ReadonlyArray<InfoQueryCase> = [
  {
    command: "get_context_usage",
    handler: getContextUsage,
    method: "getContextUsage",
    payload: { tokens: 1000, max: 200_000 },
    field: "usage",
  },
  {
    command: "get_supported_models",
    handler: getSupportedModels,
    method: "supportedModels",
    payload: ["sonnet", "opus", "haiku"],
    field: "models",
  },
  {
    command: "get_supported_commands",
    handler: getSupportedCommands,
    method: "supportedCommands",
    payload: ["/cost", "/voice"],
    field: "commands",
  },
  {
    command: "get_supported_agents",
    handler: getSupportedAgents,
    method: "supportedAgents",
    payload: ["explorer", "reviewer"],
    field: "agents",
  },
  {
    command: "get_account_info",
    handler: getAccountInfo,
    method: "accountInfo",
    payload: { plan: "pro", id: "acct-1" },
    field: "account",
  },
  {
    command: "get_mcp_server_status",
    handler: getMcpServerStatus,
    method: "mcpServerStatus",
    payload: [{ name: "render", status: "ready" }],
    field: "servers",
  },
];

describe.each(CASES)(
  "info-queries / $command",
  ({ command, handler, method, payload, field }) => {
    it("forwards the SDK response back as a successful control_response", async () => {
      const h = setup();
      h.setQueryHandle(fakeQueryHandle({ [method]: payload }));

      handler(h.ctx, cmd({ type: command as never }), h.ws);

      // Drain the runQueryOp's `.then` microtask.
      await Promise.resolve();
      await Promise.resolve();

      expect(h.wsSent).toHaveLength(1);
      const env = h.wsSent[0]!;
      expect(env["type"]).toBe("control_response");
      expect(env["command"]).toBe(command);
      expect(env["sessionKey"]).toBe("leader-1");
      expect(env["success"]).toBe(true);
      expect(env[field]).toEqual(payload);
    });

    it("replies with a 'No active query' control_error when no queryHandle is attached", () => {
      const h = setup();
      // host.queryHandle stays null.

      handler(h.ctx, cmd({ type: command as never }), h.ws);

      expect(h.wsSent).toHaveLength(1);
      expect(h.wsSent[0]!["type"]).toBe("control_response");
      expect(h.wsSent[0]!["success"]).toBe(false);
      expect(h.wsSent[0]!["error"]).toContain("No active query");
    });

    it("propagates the SDK's rejection as a control_error", async () => {
      const h = setup();
      h.setQueryHandle({
        [method]: vi.fn(async () => {
          throw new Error("model is offline");
        }),
      });

      handler(h.ctx, cmd({ type: command as never }), h.ws);

      await Promise.resolve();
      await Promise.resolve();

      expect(h.wsSent).toHaveLength(1);
      expect(h.wsSent[0]!["success"]).toBe(false);
      expect(h.wsSent[0]!["error"]).toBe("model is offline");
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
