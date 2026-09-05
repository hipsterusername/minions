import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectHeader } from "./ProjectHeader.tsx";
import { listProjects } from "./api.ts";
import type { SessionInfo } from "./use-socket.ts";

vi.mock("./api.ts", () => ({
  listProjects: vi.fn(),
}));

vi.mock("./SettingsMenu.tsx", () => ({
  SettingsMenu: () => null,
}));

const projects = [
  { id: "project-1", name: "Alpha", path: "/repo/alpha", lastOpened: "2026-01-01", hasSidecar: true },
  { id: "project-2", name: "Beta", path: "/repo/beta", lastOpened: "2026-01-02", hasSidecar: true },
];

function renderHeader(overrides: Partial<React.ComponentProps<typeof ProjectHeader>> = {}) {
  const props: React.ComponentProps<typeof ProjectHeader> = {
    projectId: "project-1",
    name: "Alpha",
    saveStatus: "idle",
    lastSaved: null,
    onRename: vi.fn(),
    onBack: vi.fn(),
    onSwitchProject: vi.fn(),
    activeView: "activity",
    onViewChange: vi.fn(),
    settings: {},
    onSettingsChange: vi.fn(),
    ...overrides,
  };
  const view = render(<ProjectHeader {...props} />);
  return { ...props, rerender: (sessions: SessionInfo[]) => view.rerender(<ProjectHeader {...props} sessions={sessions} />) };
}

describe("ProjectHeader project navigation", () => {
  beforeEach(() => {
    vi.mocked(listProjects).mockResolvedValue(projects);
  });

  it("uses the Minions logo to return to all projects", () => {
    const props = renderHeader();

    fireEvent.click(screen.getByRole("button", { name: "All projects" }));

    expect(props.onBack).toHaveBeenCalledOnce();
  });

  it("lists projects and switches directly to another project", async () => {
    const props = renderHeader();

    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));

    expect(await screen.findByRole("menu", { name: "Switch project" })).toBeVisible();
    expect(screen.getByRole("menuitemradio", { name: /Alpha/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Beta/ }));

    expect(props.onSwitchProject).toHaveBeenCalledWith("project-2", "/repo/beta");
    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: "Switch project" })).not.toBeInTheDocument();
    });
  });

  it("keeps project renaming available from the switcher", async () => {
    const onRename = vi.fn();
    renderHeader({ onRename });

    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename project" }));
    const input = screen.getByDisplayValue("Alpha");
    fireEvent.change(input, { target: { value: "Alpha Prime" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onRename).toHaveBeenCalledWith("Alpha Prime");
  });

  it("previews active agents in their workspace and caps the visible roster", async () => {
    const session = (sessionKey: string, overrides: Partial<SessionInfo> = {}): SessionInfo => ({
      sessionKey, sessionId: null, taskName: sessionKey, role: "minion",
      status: "running", cwd: "/repo/alpha", ...overrides,
    });
    renderHeader({ sessions: [
      session("Build feature", { role: "leader" }),
      session("Review changes", { cwd: "/central/worktree", projectId: "project-1", status: "waiting" }),
      session("Write docs", { cwd: "/repo/alpha/.worktrees/docs", status: "creating" }),
      session("Overflow task"),
      session("Completed task", { status: "completed" }),
      session("Idle task", { status: "idle" }),
      session("Other workspace", { projectId: "project-2" }),
      session("Unrelated task", { cwd: "/repo/alphabet" }),
    ] });

    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    const alpha = within(await screen.findByRole("menuitemradio", { name: /Alpha/ }));
    expect(alpha.getByText("4 active")).toBeVisible();
    expect(alpha.getByText("Build feature")).toBeVisible();
    expect(alpha.getByText("Review changes")).toBeVisible();
    expect(alpha.getByText("Waiting")).toBeVisible();
    expect(alpha.getByText("Write docs")).toBeVisible();
    expect(alpha.getByText("Starting")).toBeVisible();
    expect(alpha.getByText("+1 more")).toBeVisible();
    for (const title of ["Overflow task", "Completed task", "Idle task", "Other workspace", "Unrelated task"]) {
      expect(alpha.queryByText(title)).not.toBeInTheDocument();
    }
    const beta = within(screen.getByRole("menuitemradio", { name: /Beta/ }));
    expect(beta.getByText("Other workspace")).toBeVisible();
    expect(beta.getByText("1 active")).toBeVisible();
  });

  it("updates the open preview when agents finish without fetching projects again", async () => {
    const session: SessionInfo = {
      sessionKey: "minion-1", sessionId: null, role: "minion",
      taskName: "Live task", cwd: "/repo/alpha", status: "running",
    };
    const props = renderHeader({ sessions: [session] });
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(await screen.findByText("Live task")).toBeVisible();
    const calls = vi.mocked(listProjects).mock.calls.length;

    props.rerender([{ ...session, status: "completed" }]);

    expect(screen.queryByText("Live task")).not.toBeInTheDocument();
    expect(screen.queryByText(/active$/)).not.toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "Switch project" })).toBeVisible();
    expect(vi.mocked(listProjects).mock.calls.length).toBe(calls);
  });
});
