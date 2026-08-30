import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectPanel } from "./ProjectPanel.tsx";
import { getProjectContext } from "./api.ts";
import type { SocketSubscribe } from "./use-socket.ts";

vi.mock("./api.ts", () => ({
  getProjectContext: vi.fn(),
  updateProjectContext: vi.fn(),
  getProjectTree: vi.fn(async () => []),
}));

describe("ProjectPanel context updates", () => {
  it("replaces the empty state when a Leader publishes project context", async () => {
    vi.mocked(getProjectContext).mockResolvedValue({
      exists: true,
      content: "# Project\n\nProject context has not been configured yet.\n",
    });
    let listener: ((message: unknown) => void) | undefined;
    const subscribe = Object.assign(
      vi.fn((_topic: string, next: (message: unknown) => void) => {
        listener = next;
        return () => {};
      }),
      { supportsTopics: true as const },
    ) as SocketSubscribe;

    render(
      <ProjectPanel
        projectId="workspace-1"
        projectPath="/source/project"
        projectName="Project"
        onSpawnContextExplorer={vi.fn()}
        socketSubscribe={subscribe}
        nodes={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Project/ }));
    await screen.findByText(/No project context configured yet/);
    expect(subscribe).toHaveBeenCalledWith("project:workspace-1", expect.any(Function));

    act(() => listener?.({
      type: "project_context_updated",
      projectId: "workspace-1",
      content: "# Architecture\n\nMinions inherit this context.",
    }));

    await waitFor(() => expect(screen.queryByText(/No project context configured yet/)).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "context" }));
    expect(screen.getByText(/Minions inherit this context/)).toBeInTheDocument();
  });
});
