import { describe, expect, it } from "vitest";
import { canvasContext } from "../../server/commands/canvas-context.ts";
import { validateWsCommand } from "../../server/commands/schemas.ts";
import { cmd, setup } from "../../server/commands/test-harness.ts";

describe("canvas_context WS command contract", () => {
  it("accepts a full connected-canvas snapshot", () => {
    const result = validateWsCommand({
      type: "canvas_context",
      sessionKey: "leader-1",
      items: [
        {
          nodeId: "note-1",
          nodeType: "markdown",
          label: "Spec note",
          content: "Use the compact route.",
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("rejects malformed context items", () => {
    const result = validateWsCommand({
      type: "canvas_context",
      sessionKey: "leader-1",
      items: [{ nodeId: "note-1", content: "missing fields" }],
    });

    expect(result.ok).toBe(false);
  });

  it("replaces the prior session snapshot and clears on an empty snapshot", () => {
    const h = setup({ sessionKey: "leader-1" });

    canvasContext(
      h.ctx,
      cmd({
        type: "canvas_context",
        items: [
          {
            nodeId: "note-1",
            nodeType: "markdown",
            label: "Old",
            content: "old context",
          },
        ],
      }),
      h.ws,
    );
    canvasContext(
      h.ctx,
      cmd({
        type: "canvas_context",
        items: [
          {
            nodeId: "note-2",
            nodeType: "markdown",
            label: "New",
            content: "new context",
          },
        ],
      }),
      h.ws,
    );

    expect(h.host.canvasContext).toContain("new context");
    expect(h.host.canvasContext).not.toContain("old context");

    canvasContext(h.ctx, cmd({ type: "canvas_context", items: [] }), h.ws);

    expect(h.host.canvasContext).toBeNull();
  });
});
