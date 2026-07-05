import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProject, listProjects } from "../api.ts";
import type { MobileSessionInfo } from "./mobile-selectors.ts";
import { ProjectsScreen } from "./ProjectsScreen.tsx";

vi.mock("../api.ts", () => ({
  createProject: vi.fn(),
  listProjects: vi.fn(),
}));

afterEach(() => {
  vi.mocked(createProject).mockReset();
  vi.mocked(listProjects).mockReset();
  vi.restoreAllMocks();
});

function session(overrides: Partial<MobileSessionInfo>): MobileSessionInfo {
  return {
    sessionKey: overrides.sessionKey ?? "s-1",
    sessionId: null,
    status: overrides.status ?? "idle",
    cwd: overrides.cwd ?? "/work/alpha",
    ...overrides,
  };
}

describe("ProjectsScreen", () => {
  it("lists projects with per-project session counts and attention, and selects one", async () => {
    vi.mocked(listProjects).mockResolvedValue([
      { id: "alpha", name: "Alpha", path: "/work/alpha", lastOpened: "2026-06-01T00:00:00.000Z", hasSidecar: true },
      { id: "beta", name: "Beta", path: "/work/beta", lastOpened: "2026-06-02T00:00:00.000Z", hasSidecar: false },
    ]);
    const onSelectProject = vi.fn();

    render(
      <ProjectsScreen
        sessions={[
          // Two sessions scoped to Alpha (one a worktree subpath, one in error).
          session({ sessionKey: "a1", cwd: "/work/alpha", status: "error" }),
          session({ sessionKey: "a2", cwd: "/work/alpha/.minions/worktrees/leader-1", status: "running" }),
          // Minions are excluded from the count.
          session({ sessionKey: "m1", cwd: "/work/alpha", role: "minion", status: "running" }),
          // A Beta session.
          session({ sessionKey: "b1", cwd: "/work/beta", status: "idle" }),
        ]}
        onSelectProject={onSelectProject}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Alpha")).toBeInTheDocument();
    });

    expect(screen.getByText("2 sessions · needs attention")).toBeInTheDocument();
    expect(screen.getByText("1 session")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Alpha"));
    expect(onSelectProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: "alpha", path: "/work/alpha" }),
    );
  });

  it("shows an empty state when there are no projects", async () => {
    vi.mocked(listProjects).mockResolvedValue([]);

    render(<ProjectsScreen sessions={[]} onSelectProject={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("No recent projects found.")).toBeInTheDocument();
    });
  });

  it("creates a project from the mobile project page and selects it", async () => {
    vi.mocked(listProjects).mockResolvedValue([]);
    vi.mocked(createProject).mockResolvedValue({
      id: "new-project",
      path: "/work/new-project",
      name: "New Project",
      transform: { x: 0, y: 0, scale: 1 },
      createdAt: "2026-07-03T12:00:00.000Z",
      updatedAt: "2026-07-03T12:00:00.000Z",
      nodes: [],
    });
    const onSelectProject = vi.fn();

    render(<ProjectsScreen sessions={[]} onSelectProject={onSelectProject} />);

    expect(screen.queryByLabelText("Project path")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    fireEvent.change(screen.getByLabelText("Project path"), {
      target: { value: "/work/new-project" },
    });
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "New Project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => {
      expect(createProject).toHaveBeenCalledWith("New Project", "/work/new-project");
    });
    expect(onSelectProject).toHaveBeenCalledWith({
      id: "new-project",
      path: "/work/new-project",
      name: "New Project",
      lastOpened: "2026-07-03T12:00:00.000Z",
      hasSidecar: true,
    });
  });
});
