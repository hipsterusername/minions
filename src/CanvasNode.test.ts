/**
 * Unit tests for isPortDynamicallyHidden.
 *
 * Covers:
 *   - Leader task-out: hidden when unconnected with no drag active
 *   - Leader task-out: visible when connected
 *   - Leader task-out: visible when unconnected but is a valid drag target
 *   - Leader context-in: hidden when locked (session started) and unconnected
 *   - Leader context-in: visible when locked but connected
 *   - File-viewer/markdown output: hidden inside context-group when unconnected
 *   - File-viewer/markdown output: visible outside context-group
 *   - File-viewer/markdown output: visible inside context-group when connected
 */

import { describe, it, expect } from "vitest";
import { isPortDynamicallyHidden } from "./CanvasNode.tsx";
import type { PortVisibilityContext } from "./CanvasNode.tsx";
import { getPortDef } from "./graph.ts";
import type { CanvasNode } from "./types.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeLeaderNode(
  id: string,
  sessionKey: string | null = null,
): CanvasNode {
  return {
    id,
    type: "leader",
    position: { x: 0, y: 0 },
    size: { width: 400, height: 500 },
    data: { sessionKey },
  };
}

function makeFileViewerNode(id: string): CanvasNode {
  return {
    id,
    type: "file-viewer",
    position: { x: 0, y: 0 },
    size: { width: 300, height: 400 },
    data: {},
  };
}

function makeMarkdownNode(id: string): CanvasNode {
  return {
    id,
    type: "markdown",
    position: { x: 0, y: 0 },
    size: { width: 300, height: 300 },
    data: {},
  };
}

function ctx(
  node: CanvasNode,
  opts: {
    connectedPorts?: string[];
    validTargetPorts?: string[];
    isInsideContextGroup?: boolean;
  } = {},
): PortVisibilityContext {
  return {
    node,
    connectedPorts: opts.connectedPorts ? new Set(opts.connectedPorts) : undefined,
    validTargetPorts: opts.validTargetPorts ? new Set(opts.validTargetPorts) : undefined,
    isInsideContextGroup: opts.isInsideContextGroup ?? false,
  };
}

// ── Leader task-out port ──────────────────────────────────────────────────────

describe("leader task-out port", () => {
  const taskOutPort = getPortDef("leader", "task-out")!;

  it("is hidden when not connected and no drag is active", () => {
    const node = makeLeaderNode("l1");
    expect(isPortDynamicallyHidden(taskOutPort, ctx(node))).toBe(true);
  });

  it("is hidden when not connected and a drag targets a different port", () => {
    const node = makeLeaderNode("l1");
    // A drag is active but targeting some other port, not this one
    expect(
      isPortDynamicallyHidden(
        taskOutPort,
        ctx(node, { validTargetPorts: ["l1:context-in", "other:task-out"] }),
      ),
    ).toBe(true);
  });

  it("is visible when an active drag targets this port", () => {
    const node = makeLeaderNode("l1");
    expect(
      isPortDynamicallyHidden(
        taskOutPort,
        ctx(node, { validTargetPorts: ["l1:task-out"] }),
      ),
    ).toBe(false);
  });

  it("is visible when connected to a minion", () => {
    const node = makeLeaderNode("l1");
    expect(
      isPortDynamicallyHidden(
        taskOutPort,
        ctx(node, { connectedPorts: ["l1:task-out"] }),
      ),
    ).toBe(false);
  });

  it("stays visible when connected even if a drag targets it", () => {
    const node = makeLeaderNode("l1");
    expect(
      isPortDynamicallyHidden(
        taskOutPort,
        ctx(node, {
          connectedPorts: ["l1:task-out"],
          validTargetPorts: ["l1:task-out"],
        }),
      ),
    ).toBe(false);
  });
});

// ── Leader context-in port ────────────────────────────────────────────────────

describe("leader context-in port", () => {
  const contextInPort = getPortDef("leader", "context-in")!;

  it("is hidden when session is active (locked) and unconnected", () => {
    const node = makeLeaderNode("l1", "session-abc");
    expect(isPortDynamicallyHidden(contextInPort, ctx(node))).toBe(true);
  });

  it("is visible when session is active but already connected", () => {
    const node = makeLeaderNode("l1", "session-abc");
    expect(
      isPortDynamicallyHidden(contextInPort, ctx(node, { connectedPorts: ["l1:context-in"] })),
    ).toBe(false);
  });

  it("is visible when no session has started yet (port is not locked)", () => {
    const node = makeLeaderNode("l1", null);
    expect(isPortDynamicallyHidden(contextInPort, ctx(node))).toBe(false);
  });
});

// ── File-viewer / markdown output ports ──────────────────────────────────────

for (const makeNode of [makeFileViewerNode, makeMarkdownNode]) {
  const nodeType = makeNode("x").type;
  const contextOutPort = getPortDef("context-provider", "context-out")!;
  // Both file-viewer and markdown share the same context-out port shape;
  // simulate by using a port definition with direction "output" directly.
  const outputPort = { ...contextOutPort };

  describe(`${nodeType} context-out port`, () => {
    it("is hidden when inside a context-group and unconnected", () => {
      const node = makeNode("n1");
      expect(
        isPortDynamicallyHidden(outputPort, ctx(node, { isInsideContextGroup: true })),
      ).toBe(true);
    });

    it("is visible when inside a context-group but connected", () => {
      const node = makeNode("n1");
      expect(
        isPortDynamicallyHidden(
          outputPort,
          ctx(node, { isInsideContextGroup: true, connectedPorts: ["n1:context-out"] }),
        ),
      ).toBe(false);
    });

    it("is visible when outside a context-group and unconnected", () => {
      const node = makeNode("n1");
      expect(
        isPortDynamicallyHidden(outputPort, ctx(node, { isInsideContextGroup: false })),
      ).toBe(false);
    });
  });
}
