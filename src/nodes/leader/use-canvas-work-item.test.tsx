import { StrictMode, useEffect, useRef } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkItemDetailSnapshot } from "../../../shared/work-item-contracts.ts";
import type { SocketSubscribeLike } from "../../use-socket.ts";
import type { LeaderData } from "./types.ts";
import { useCanvasWorkItem } from "./use-canvas-work-item.ts";

describe("useCanvasWorkItem", () => {
  it("keeps an in-flight request alive across the StrictMode effect replay", async () => {
    let listener: ((message: unknown) => void) | null = null;
    const socketSubscribe = ((next: (message: unknown) => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    }) as SocketSubscribeLike;
    const socketSend = vi.fn();
    const resolved: WorkItemDetailSnapshot[] = [];
    const rejected: Error[] = [];
    const detail = {
      workItem: { id: "work-1" },
    } as WorkItemDetailSnapshot;

    function Probe() {
      const dataRef = useRef({ workItemId: null } as LeaderData);
      const started = useRef(false);
      const { requestWorkItem } = useCanvasWorkItem({
        nodeId: "leader-1",
        projectId: "project-1",
        projectPath: "/repo",
        socketSend,
        socketSubscribe,
        dataRef,
        emitUpdate: vi.fn(),
        publishCanvasContext: vi.fn(),
      });
      useEffect(() => {
        if (started.current) return;
        started.current = true;
        void requestWorkItem({
          type: "get_work_item",
          requestId: "request-1",
          workItemId: "work-1",
        }).then((result) => resolved.push(result), (error: Error) => rejected.push(error));
      }, [requestWorkItem]);
      return null;
    }

    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    await waitFor(() => expect(socketSend).toHaveBeenCalledTimes(1));

    act(() => {
      listener?.({
        type: "work_item_response",
        requestId: "request-1",
        success: true,
        result: detail,
      });
    });

    await waitFor(() => expect(resolved).toEqual([detail]));
    expect(rejected).toEqual([]);
  });
});
