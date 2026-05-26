import { describe, expect, it } from "vitest";

import { decideConnectionDropAction } from "./connection-drop-decision.ts";
import type { PortInfo } from "./components/PortDot.tsx";

const renderContextOutput: PortInfo = {
  nodeId: "render-1",
  portId: "context-out",
  nodeType: "render",
  direction: "output",
  protocol: "context",
};

const leaderContextInput: PortInfo = {
  nodeId: "leader-1",
  portId: "context-in",
  nodeType: "leader",
  direction: "input",
  protocol: "context",
};

describe("decideConnectionDropAction", () => {
  it("returns consumed-by-port when the port-level handler already took the drop, even when dashboard menu would otherwise show", () => {
    // Regression: dragging from a render dashboard's context port and
    // releasing on an existing Leader's input port used to show the
    // "improve / execute / analyze / custom" menu (as if a new leader
    // should be spawned). The port-level handler creates the edge first
    // and sets consumedByPort, so the canvas-level decision must no-op.
    expect(
      decideConnectionDropAction({
        source: renderContextOutput,
        snapTarget: null,
        consumedByPort: true,
        compatibleLeaderInputPortId: "context-in",
      }),
    ).toEqual({ kind: "consumed-by-port" });
  });

  it("returns consumed-by-port even when a snap target is also present", () => {
    expect(
      decideConnectionDropAction({
        source: renderContextOutput,
        snapTarget: leaderContextInput,
        consumedByPort: true,
        compatibleLeaderInputPortId: "context-in",
      }),
    ).toEqual({ kind: "consumed-by-port" });
  });

  it("returns snap-connect when a snap target is within range and the port didn't consume the drop", () => {
    expect(
      decideConnectionDropAction({
        source: renderContextOutput,
        snapTarget: leaderContextInput,
        consumedByPort: false,
        compatibleLeaderInputPortId: "context-in",
      }),
    ).toEqual({ kind: "snap-connect", snap: leaderContextInput });
  });

  it("shows the dashboard menu only for render+context output dropped on empty canvas", () => {
    expect(
      decideConnectionDropAction({
        source: renderContextOutput,
        snapTarget: null,
        consumedByPort: false,
        compatibleLeaderInputPortId: "context-in",
      }),
    ).toEqual({ kind: "show-dashboard-menu" });
  });

  it("falls back to creating a default leader for non-dashboard output ports", () => {
    expect(
      decideConnectionDropAction({
        source: {
          ...renderContextOutput,
          nodeType: "markdown",
          protocol: "context",
        },
        snapTarget: null,
        consumedByPort: false,
        compatibleLeaderInputPortId: "context-in",
      }),
    ).toEqual({ kind: "create-default-leader" });
  });

  it("noops when the source is an input port (drags from input don't auto-spawn leaders)", () => {
    expect(
      decideConnectionDropAction({
        source: { ...leaderContextInput },
        snapTarget: null,
        consumedByPort: false,
        compatibleLeaderInputPortId: "context-in",
      }),
    ).toEqual({ kind: "noop" });
  });

  it("noops when there is no compatible leader input port for the source protocol", () => {
    expect(
      decideConnectionDropAction({
        source: renderContextOutput,
        snapTarget: null,
        consumedByPort: false,
        compatibleLeaderInputPortId: null,
      }),
    ).toEqual({ kind: "noop" });
  });
});
