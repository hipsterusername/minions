import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TaskPlanItem } from "./types.ts";
import { MinionsSurface } from "./MinionsSurface.tsx";
import type { SocketSubscribe } from "../../use-socket.ts";

function task(overrides: Partial<TaskPlanItem> = {}): TaskPlanItem {
  return {
    taskId: "task-1",
    title: "Refine navigation",
    description: "Consolidate the navigation surfaces.",
    priority: "high",
    status: "running",
    executor: "minion",
    minionSessionKey: "minion-1",
    result: null,
    cost: 0,
    createdAt: 1,
    completedAt: null,
    sessionSummary: "",
    activeStep: "Reviewing the current layout",
    progress: [],
    ...overrides,
  };
}

describe("MinionsSurface", () => {
  it("shows each minion name and active task, then reveals the selected task", async () => {
    const onSelectTask = vi.fn();
    const tasks = [
      task(),
      task({
        taskId: "task-2",
        title: "Write interaction tests",
        description: "Cover minion selection and logs.",
        minionSessionKey: "minion-2",
        activeStep: "Building fixtures",
      }),
    ];
    const { rerender } = render(
      <MinionsSurface tasks={tasks} selectedTaskId="task-1" onSelectTask={onSelectTask} />,
    );

    expect(screen.getAllByText("Minion 01").length).toBeGreaterThan(0);
    expect(screen.getByText("Minion 02")).toBeInTheDocument();
    expect(screen.getAllByText("Refine navigation").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Minion 2: Write interaction tests" }));
    expect(onSelectTask).toHaveBeenCalledWith("task-2");

    rerender(<MinionsSurface tasks={tasks} selectedTaskId="task-2" onSelectTask={onSelectTask} />);
    expect(screen.getByRole("heading", { name: "Write interaction tests" })).toBeInTheDocument();
    expect(screen.getByText("Building fixtures")).toBeInTheDocument();
    expect(screen.getByText("Cover minion selection and logs.")).toBeInTheDocument();
  });

  it("syncs and renders the selected minion session log", async () => {
    const socketSend = vi.fn();
    let listener: ((message: unknown) => void) | undefined;
    const socketSubscribe = Object.assign(
      ((first: string | ((message: unknown) => void), second?: (message: unknown) => void) => {
        listener = typeof first === "function" ? first : second;
        return () => undefined;
      }) as SocketSubscribe,
      { supportsTopics: true as const },
    );
    render(
      <MinionsSurface
        tasks={[task()]}
        selectedTaskId="task-1"
        onSelectTask={() => undefined}
        socketSend={socketSend}
        socketSubscribe={socketSubscribe}
      />,
    );

    expect(socketSend).toHaveBeenCalledWith({ type: "sync_session", sessionKey: "minion-1" });
    expect(listener).toBeDefined();
    act(() => {
      listener?.({
        type: "sync_response",
        sessionKey: "minion-1",
        found: true,
        status: "running",
        events: [{
          type: "sdk_event",
          sessionKey: "minion-1",
          timestamp: 2,
          event: { kind: "text", role: "assistant", text: "Updated the tab behavior.", timestamp: 2 },
        }],
      });
    });

    await waitFor(() => expect(screen.getByText("Updated the tab behavior.")).toBeInTheDocument());
  });
});
