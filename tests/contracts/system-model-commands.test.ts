import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { attachConnectionListeners } from "../../server/ws-connection.ts";
import type { ConnectionDeps } from "../../server/ws-connection.ts";
import { dispatchCommand } from "../../server/commands/index.ts";
import { cmd, setup } from "../support/server-command-harness.ts";
import { writeSettings } from "../../server/project-store.ts";
import { copyValidFixture, copyValidFixtureWithSurfaces } from "../../server/system-model/load.test.ts";

class FakeWs extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  send(msg: string): void {
    this.sent.push(msg);
  }
}

function deps(dispatch = vi.fn()): ConnectionDeps {
  return { snapshotSessions: () => [], dispatch };
}

function send(ws: FakeWs, payload: unknown): void {
  ws.emit("message", Buffer.from(JSON.stringify(payload)));
}

describe("contract: system-model WS commands", () => {
  it("dispatches valid system-model commands", () => {
    const ws = new FakeWs();
    const dispatch = vi.fn();
    attachConnectionListeners(ws as unknown as WebSocket, deps(dispatch));
    ws.sent = [];

    send(ws, { type: "get_system_model_status", sessionKey: "leader-1" });
    send(ws, { type: "get_system_graph", sessionKey: "leader-1" });

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls.map((call) => call[0].type)).toEqual([
      "get_system_model_status",
      "get_system_graph",
    ]);
  });

  it("rejects malformed system-model commands before dispatch", () => {
    const ws = new FakeWs();
    const dispatch = vi.fn();
    attachConnectionListeners(ws as unknown as WebSocket, deps(dispatch));
    ws.sent = [];

    send(ws, { type: "get_system_graph", sessionKey: 42 });

    expect(dispatch).not.toHaveBeenCalled();
    expect(JSON.parse(ws.sent[0]!).type).toBe("error");
  });

  it("get_system_model_status reports fixture counts", () => {
    const project = copyValidFixture();
    writeSettings(project, { systemModel: "advisory" });
    const h = setup({ cwd: project });

    dispatchCommand(h.ctx, cmd({ type: "get_system_model_status" }), h.ws);

    const response = h.wsSent[0] as { status?: { counts?: { domains: number; capabilities: number } } };
    expect(response.status?.counts?.domains).toBe(1);
    expect(response.status?.counts?.capabilities).toBe(1);
  });

  it("get_system_graph returns graph nodes and edges", () => {
    const project = copyValidFixtureWithSurfaces();
    writeSettings(project, { systemModel: "advisory" });
    const h = setup({ cwd: project });

    dispatchCommand(h.ctx, cmd({ type: "get_system_graph" }), h.ws);

    const response = h.wsSent[0] as {
      graph?: {
        nodes: Array<{ id: string; type: string }>;
        edges: Array<{ id: string; relation: string; files?: string[] }>;
      };
    };
    expect(response.graph?.nodes.some((node) => node.id === "capability.workspace_management")).toBe(true);
    expect(response.graph?.nodes).toContainEqual(expect.objectContaining({ id: "domain.workspace", type: "domain" }));
    expect(response.graph?.edges).toContainEqual(expect.objectContaining({ relation: "implements" }));
    expect(response.graph?.edges).toContainEqual(expect.objectContaining({ relation: "guards" }));
    expect(response.graph?.edges.length).toBeGreaterThan(0);
    expect(response.graph?.nodes).toContainEqual(expect.objectContaining({
      id: "surface.mobile", type: "surface",
    }));
    expect(response.graph?.edges).toContainEqual(expect.objectContaining({
      relation: "entry_point", files: ["src/mobile/**"],
    }));
  });
});
