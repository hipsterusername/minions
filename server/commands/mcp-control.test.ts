/**
 * reconnect_mcp_server / toggle_mcp_server — both delegate to query-handle
 * methods. Same shape; collapsed into a parameterised describe per §5.9.
 */
import { describe, expect, it, vi } from "vitest";
import { reconnectMcpServer, toggleMcpServer } from "./mcp-control.ts";
import { setup, cmd } from "./test-harness.ts";

describe("reconnect_mcp_server", () => {
  it("invokes queryHandle.reconnectMcpServer with serverName and replies success", async () => {
    const h = setup();
    const reconnect = vi.fn(async () => undefined);
    h.setQueryHandle({ reconnectMcpServer: reconnect });

    reconnectMcpServer(
      h.ctx,
      cmd({ type: "reconnect_mcp_server", serverName: "render" }),
      h.ws,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(reconnect).toHaveBeenCalledWith("render");
    expect(h.wsSent[0]!["success"]).toBe(true);
    expect(h.wsSent[0]!["serverName"]).toBe("render");
  });

  it("rejects when serverName is missing", () => {
    const h = setup();
    h.setQueryHandle({ reconnectMcpServer: vi.fn() });
    reconnectMcpServer(
      h.ctx,
      cmd({ type: "reconnect_mcp_server", serverName: undefined }),
      h.ws,
    );
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toContain("serverName required");
  });

  it("propagates the SDK rejection as control_error", async () => {
    const h = setup();
    h.setQueryHandle({
      reconnectMcpServer: vi.fn(async () => {
        throw new Error("server gone");
      }),
    });
    reconnectMcpServer(
      h.ctx,
      cmd({ type: "reconnect_mcp_server", serverName: "x" }),
      h.ws,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toBe("server gone");
  });
});

describe("toggle_mcp_server", () => {
  it("invokes queryHandle.toggleMcpServer with serverName + enabled and replies success", async () => {
    const h = setup();
    const toggle = vi.fn(async () => undefined);
    h.setQueryHandle({ toggleMcpServer: toggle });

    toggleMcpServer(
      h.ctx,
      cmd({
        type: "toggle_mcp_server",
        serverName: "render",
        enabled: true,
      }),
      h.ws,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(toggle).toHaveBeenCalledWith("render", true);
    expect(h.wsSent[0]!["success"]).toBe(true);
    expect(h.wsSent[0]!["serverName"]).toBe("render");
    expect(h.wsSent[0]!["enabled"]).toBe(true);
  });

  it("rejects when either serverName or enabled is missing", () => {
    const h = setup();
    h.setQueryHandle({ toggleMcpServer: vi.fn() });

    toggleMcpServer(
      h.ctx,
      cmd({ type: "toggle_mcp_server", serverName: "x", enabled: undefined }),
      h.ws,
    );
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toContain("required");

    h.wsSent.length = 0;
    toggleMcpServer(
      h.ctx,
      cmd({ type: "toggle_mcp_server", serverName: undefined, enabled: true }),
      h.ws,
    );
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toContain("required");
  });
});
