import { describe, expect, it, vi } from "vitest";
import { reconnectMcpServer, toggleMcpServer } from "./mcp-control.ts";
import { setup, cmd, fakeRunControl } from "../../tests/support/server-command-harness.ts";

describe("reconnect_mcp_server", () => {
  it("invokes runControl.reconnectMcpServer with serverName and replies success", async () => {
    const h = setup();
    const reconnect = vi.fn(async () => undefined);
    h.setRunControl(fakeRunControl({ reconnectMcpServer: reconnect }));

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
    h.setRunControl(fakeRunControl({ reconnectMcpServer: vi.fn() }));
    reconnectMcpServer(
      h.ctx,
      cmd({ type: "reconnect_mcp_server", serverName: undefined }),
      h.ws,
    );
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toContain("serverName required");
  });

  it("replies with control_error when no runControl is attached (No active query)", () => {
    const h = setup();
    reconnectMcpServer(
      h.ctx,
      cmd({ type: "reconnect_mcp_server", serverName: "x" }),
      h.ws,
    );
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toContain("No active query");
  });

  it("replies 'unsupported by harness' when reconnectMcpServer is absent on the control", () => {
    const h = setup();
    h.host.harnessName = "echo";
    h.setRunControl({ abort() {} });

    reconnectMcpServer(
      h.ctx,
      cmd({ type: "reconnect_mcp_server", serverName: "x" }),
      h.ws,
    );

    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toMatch(/"reconnect_mcp_server"/);
    expect(h.wsSent[0]!["error"]).toMatch(/"echo"/);
  });

  it("propagates the SDK rejection as control_error", async () => {
    const h = setup();
    h.setRunControl(fakeRunControl({
      reconnectMcpServer: vi.fn(async () => { throw new Error("server gone"); }),
    }));
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
  it("invokes runControl.toggleMcpServer with serverName + enabled and replies success", async () => {
    const h = setup();
    const toggle = vi.fn(async () => undefined);
    h.setRunControl(fakeRunControl({ toggleMcpServer: toggle }));

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
    h.setRunControl(fakeRunControl({ toggleMcpServer: vi.fn() }));

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

  it("replies with control_error when no runControl is attached (No active query)", () => {
    const h = setup();
    toggleMcpServer(
      h.ctx,
      cmd({ type: "toggle_mcp_server", serverName: "x", enabled: true }),
      h.ws,
    );
    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toContain("No active query");
  });

  it("replies 'unsupported by harness' when toggleMcpServer is absent on the control", () => {
    const h = setup();
    h.host.harnessName = "echo";
    h.setRunControl({ abort() {} });

    toggleMcpServer(
      h.ctx,
      cmd({ type: "toggle_mcp_server", serverName: "x", enabled: false }),
      h.ws,
    );

    expect(h.wsSent[0]!["success"]).toBe(false);
    expect(h.wsSent[0]!["error"]).toMatch(/"toggle_mcp_server"/);
    expect(h.wsSent[0]!["error"]).toMatch(/"echo"/);
  });
});
