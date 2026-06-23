/**
 * Payload-validation tests for RenderNode's render_update subscription.
 *
 * Verifies that:
 *   - A valid render_update payload is applied without error.
 *   - A malformed payload shows an inline error banner instead of crashing.
 *
 * Strategy: mount RenderNodeRenderer with a controlled socketSubscribe that
 * captures the registered listener, then fire test messages directly into it
 * and assert on the rendered state.
 */

import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { RenderNodeRenderer, type RenderNodeData } from "./RenderNode.tsx";
import type { CanvasNode, NodeRenderProps } from "../types.ts";
import type { SocketSubscribe } from "../use-socket.ts";

// ── Helpers ──────────────────────────────────────────────

/**
 * Create a minimal SocketSubscribe that records the last subscriber
 * registered for any topic and exposes a `fire(msg)` helper.
 */
function makeSocketHarness() {
  let lastListener: ((msg: unknown) => void) | null = null;

  const subscribe: SocketSubscribe = Object.assign(
    ((...args: [(msg: unknown) => void] | [string, (msg: unknown) => void]) => {
      const fn = args.length === 1 ? args[0] : args[1];
      lastListener = fn;
      return () => { lastListener = null; };
    }) as SocketSubscribe,
    { supportsTopics: true as const },
  );

  return {
    subscribe,
    fire: (msg: unknown) => {
      lastListener?.(msg);
    },
  };
}

function makeBaseData(): RenderNodeData {
  return {
    leaderSessionKey: "leader-1",
    leaderId: "leader-node",
    renderState: {
      layout: { columns: 2, gap: 12 },
      components: [],
    },
  };
}

interface ProbeProps {
  socket: ReturnType<typeof makeSocketHarness>;
  initial: RenderNodeData;
  onState?: (d: RenderNodeData) => void;
}

function Probe({ socket, initial, onState }: ProbeProps) {
  const [data, setData] = useState<RenderNodeData>(initial);
  const node: CanvasNode = {
    id: "render-test",
    type: "render",
    position: { x: 0, y: 0 },
    size: { width: 500, height: 420 },
    data,
  };
  const props: NodeRenderProps = {
    node,
    isSelected: false,
    onUpdateData: (next) => {
      const nextData = next as RenderNodeData;
      setData(nextData);
      onState?.(nextData);
    },
    socketSubscribe: socket.subscribe,
  };
  return <RenderNodeRenderer {...props} />;
}

// ── Tests ─────────────────────────────────────────────────

describe("RenderNode payload validation", () => {
  it("applies a valid render_update set message without showing an error", async () => {
    const socket = makeSocketHarness();
    const onState = vi.fn();

    render(<Probe socket={socket} initial={makeBaseData()} onState={onState} />);

    act(() => {
      socket.fire({
        type: "render_update",
        leaderSessionKey: "leader-1",
        action: "set",
        components: [
          { id: "m1", type: "metric", label: "Open PRs", value: "4" },
        ],
      });
    });

    // No error banner
    expect(screen.queryByRole("alert")).toBeNull();

    // The metric component should now be in the rendered state
    expect(onState).toHaveBeenCalled();
    const updatedData = onState.mock.calls[onState.mock.calls.length - 1]?.[0] as RenderNodeData;
    expect(updatedData.renderState.components).toHaveLength(1);
    expect(updatedData.renderState.components[0]?.type).toBe("metric");
  });

  it("shows an inline error banner when the payload has an invalid action", async () => {
    const socket = makeSocketHarness();

    render(<Probe socket={socket} initial={makeBaseData()} />);

    act(() => {
      socket.fire({
        type: "render_update",
        leaderSessionKey: "leader-1",
        action: "not_a_real_action", // invalid
        components: [],
      });
    });

    // Error banner should be rendered
    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(alert.textContent).toMatch(/invalid render payload/i);
  });

  it("shows an error banner when components field is missing for a set action", async () => {
    const socket = makeSocketHarness();

    render(<Probe socket={socket} initial={makeBaseData()} />);

    act(() => {
      socket.fire({
        type: "render_update",
        leaderSessionKey: "leader-1",
        action: "set",
        // components missing → zod should reject
      });
    });

    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("does not show an error for non-render_update messages on the session topic", () => {
    const socket = makeSocketHarness();

    render(<Probe socket={socket} initial={makeBaseData()} />);

    // A session_status message should be silently ignored (type guard in the effect)
    act(() => {
      socket.fire({
        type: "session_status",
        sessionKey: "leader-1",
        status: "running",
      });
    });

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
