import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProject, getHarnessReadiness, listProjects } from "../api.ts";
import type { MobileSessionInfo } from "./mobile-selectors.ts";
import { ProjectsScreen } from "./ProjectsScreen.tsx";

vi.mock("../api.ts", () => ({
  createProject: vi.fn(),
  listProjects: vi.fn(),
  getHarnessReadiness: vi.fn(async () => ({ schemaVersion: 1, checkedAt: "", expiresAt: "", ready: true, readyHarnesses: ["claude"], harnesses: [] })),
}));

afterEach(() => {
  vi.mocked(createProject).mockReset();
  vi.mocked(listProjects).mockReset();
  vi.mocked(getHarnessReadiness).mockResolvedValue({ schemaVersion: 1, checkedAt: "", expiresAt: "", ready: true, readyHarnesses: ["claude"], harnesses: [] });
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
          // Three leaders scoped to Alpha (one a worktree subpath, one waiting, one in error).
          session({ sessionKey: "a1", cwd: "/work/alpha", status: "error", totalCost: 0.12 }),
          session({ sessionKey: "a2", cwd: "/work/alpha/.minions/worktrees/leader-1", status: "running", totalCost: 0.3 }),
          session({ sessionKey: "a3", cwd: "/work/alpha/.minions/worktrees/leader-2", status: "waiting" }),
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

    expect(screen.getByText("▶ 2 active · $0.42 · ⚠ 2 needs you")).toBeInTheDocument();
    expect(screen.getByText("1 session · $0.00")).toBeInTheDocument();

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
