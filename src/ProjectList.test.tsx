import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectList } from "./ProjectList.tsx";
import {
  checkProjectGit,
  createProject,
  deleteProject,
  getHarnessReadiness,
  listProjects,
  openProject,
} from "./api.ts";
import type { SessionInfo } from "./use-socket.ts";

const socketSend = vi.fn();
let sessionSnapshot: SessionInfo[] = [];

vi.mock("./use-socket.ts", () => ({
  useSocket: () => ({
    connected: true,
    send: socketSend,
    subscribe: vi.fn(),
  }),
}));

vi.mock("./use-session-activity.ts", () => ({
  useSessionActivity: () => ({
    sessions: sessionSnapshot,
    mobileSessions: sessionSnapshot,
  }),
}));

vi.mock("./api.ts", () => ({
  listProjects: vi.fn(),
  checkProjectGit: vi.fn(),
  createProject: vi.fn(),
  openProject: vi.fn(),
  deleteProject: vi.fn(),
  getHarnessReadiness: vi.fn(),
}));

const ready = {
  schemaVersion: 1 as const,
  checkedAt: "2026-07-10T00:00:00Z",
  expiresAt: "2026-07-10T00:01:00Z",
  ready: true,
  readyHarnesses: ["codex"],
  harnesses: [{
    name: "codex",
    ready: true,
    state: "ready" as const,
    runtime: { available: true, source: "sdk_bundled" as const },
    auth: { authenticated: true, source: "cli_login" as const },
    checkedAt: "2026-07-10T00:00:00Z",
    expiresAt: "2026-07-10T00:01:00Z",
    durationMs: 2,
  }],
};

const project = {
  id: "p1",
  path: "/repo/alpha",
  name: "Alpha",
  lastOpened: "2026-07-10T00:00:00Z",
  hasSidecar: true,
};

describe("ProjectList journeys", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sessionSnapshot = [];
    vi.mocked(listProjects).mockResolvedValue([project]);
    vi.mocked(getHarnessReadiness).mockResolvedValue(ready);
    vi.mocked(checkProjectGit).mockResolvedValue({ isRepository: true });
    vi.mocked(openProject).mockResolvedValue({ ...project, transform: { x: 0, y: 0, scale: 1 }, createdAt: "", updatedAt: "", nodes: [] });
    vi.mocked(createProject).mockResolvedValue({ ...project, transform: { x: 0, y: 0, scale: 1 }, createdAt: "", updatedAt: "", nodes: [] });
    vi.mocked(deleteProject).mockResolvedValue({});
  });

  it("renders the README logomark with theme-driven color layers", () => {
    render(<ProjectList onOpenProject={vi.fn()} />);

    const logo = screen.getByRole("img", { name: "Minions" });
    expect(logo).toHaveClass("project-list-brand");
    expect(logo.querySelector(".project-list-brand__base")).toBeInTheDocument();
    expect(logo.querySelector(".project-list-brand__crown")).toBeInTheDocument();
  });

  it("shows a sleeping project when it has no active sessions", async () => {
    render(<ProjectList onOpenProject={vi.fn()} />);

    expect(await screen.findByRole("img", { name: "Alpha is sleeping with no active sessions" })).toHaveClass(
      "project-list-recent__activity--sleeping",
    );
    expect(screen.getByText("0 active sessions")).toBeInTheDocument();
  });

  it("counts running, creating, and waiting leaders while excluding minions", async () => {
    sessionSnapshot = [
      { sessionKey: "leader-1", sessionId: "s1", status: "running", cwd: "/repo/alpha", role: "leader" },
      { sessionKey: "leader-2", sessionId: "s2", status: "creating", cwd: "/repo/alpha/.minions/worktrees/leader-2", role: "leader" },
      { sessionKey: "leader-3", sessionId: "s3", status: "waiting", cwd: "/repo/alpha/.minions/worktrees/leader-3", role: "leader" },
      { sessionKey: "minion-1", sessionId: "s3", status: "running", cwd: "/repo/alpha/.minions/worktrees/minion-1", role: "minion" },
      { sessionKey: "other", sessionId: "s4", status: "running", cwd: "/repo/beta", role: "leader" },
    ];
    render(<ProjectList onOpenProject={vi.fn()} />);

    const activity = await screen.findByRole("img", { name: "Alpha has 3 active sessions" });
    expect(activity).toHaveClass("project-list-recent__activity--active");
    expect(activity.querySelector('img[src="/icons/minion.svg"]')).toBeInTheDocument();
    expect(screen.getByText("3 active sessions")).toHaveClass("project-list-recent__session-count--active");
  });

  it("opens a recent project without issuing a second server request", async () => {
    const onOpenProject = vi.fn();
    render(<ProjectList onOpenProject={onOpenProject} />);

    const openButton = await screen.findByRole("button", { name: "Open Alpha" });
    expect(openButton.tagName).toBe("BUTTON");
    expect(openButton).toHaveAttribute("type", "button");
    expect(openButton.querySelector("button")).toBeNull();
    fireEvent.click(openButton);

    expect(onOpenProject).toHaveBeenCalledWith("p1", "/repo/alpha");
    expect(openProject).not.toHaveBeenCalled();
  });

  it("opens a typed folder and trims surrounding whitespace", async () => {
    const onOpenProject = vi.fn();
    render(<ProjectList onOpenProject={onOpenProject} />);
    const path = await screen.findByPlaceholderText("/path/to/existing/project...");

    fireEvent.change(path, { target: { value: "  /repo/alpha  " } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() => expect(openProject).toHaveBeenCalledWith("/repo/alpha"));
    expect(onOpenProject).toHaveBeenCalledWith("p1", "/repo/alpha");
  });

  it("creates with an explicit name and path", async () => {
    const onOpenProject = vi.fn();
    render(<ProjectList onOpenProject={onOpenProject} />);
    await screen.findByText("Alpha");

    fireEvent.click(screen.getByRole("button", { name: "New Project" }));
    fireEvent.change(screen.getByPlaceholderText("/path/to/new/project..."), { target: { value: "/repo/new" } });
    fireEvent.change(screen.getByPlaceholderText(/Project name/), { target: { value: "New repo" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createProject).toHaveBeenCalledWith("New repo", "/repo/new"));
  });

  it("requires an explicit choice before initializing Git and creating the first commit", async () => {
    vi.mocked(checkProjectGit).mockResolvedValue({ isRepository: false });
    render(<ProjectList onOpenProject={vi.fn()} />);
    await screen.findByText("Alpha");

    fireEvent.click(screen.getByRole("button", { name: "New Project" }));
    fireEvent.change(screen.getByPlaceholderText("/path/to/new/project..."), { target: { value: "/repo/new" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Minions may run into issues");
    expect(createProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Initialize Git & create first commit" }));

    await waitFor(() => {
      expect(createProject).toHaveBeenCalledWith("Untitled", "/repo/new", "initialize");
    });
  });

  it("allows opening a non-Git folder only after acknowledging the warning", async () => {
    vi.mocked(checkProjectGit).mockResolvedValue({ isRepository: false });
    render(<ProjectList onOpenProject={vi.fn()} />);
    const path = await screen.findByPlaceholderText("/path/to/existing/project...");

    fireEvent.change(path, { target: { value: "/repo/plain" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue without Git" }));

    await waitFor(() => {
      expect(openProject).toHaveBeenCalledWith("/repo/plain", "continue_without_git");
    });
  });

  it("keeps recent projects usable when the optional readiness check fails", async () => {
    vi.mocked(getHarnessReadiness).mockRejectedValue(new Error("probe offline"));
    const onOpenProject = vi.fn();
    render(<ProjectList onOpenProject={onOpenProject} />);

    fireEvent.click(await screen.findByText("Alpha"));

    expect(onOpenProject).toHaveBeenCalledWith("p1", "/repo/alpha");
  });

  it("hides healthy harness status from the project picker", async () => {
    render(<ProjectList onOpenProject={vi.fn()} />);

    await screen.findByText("Alpha");
    expect(screen.queryByText(/codex: ready/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /check again/i })).not.toBeInTheDocument();
  });

  it("blocks initialization and offers a contextual recheck when no harness is ready", async () => {
    vi.mocked(getHarnessReadiness)
      .mockResolvedValueOnce({ ...ready, ready: false, readyHarnesses: [], harnesses: [{ ...ready.harnesses[0]!, ready: false, state: "unauthenticated" }] })
      .mockResolvedValueOnce(ready);
    render(<ProjectList onOpenProject={vi.fn()} />);
    const path = await screen.findByPlaceholderText("/path/to/existing/project...");
    fireEvent.change(path, { target: { value: "/repo/new" } });

    expect(screen.getByRole("button", { name: "Open" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Sign in to Claude or Codex");
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Open" })).toBeEnabled());
    expect(getHarnessReadiness).toHaveBeenLastCalledWith(true);
  });

  it("removes a recent item without opening it", async () => {
    const onOpenProject = vi.fn();
    render(<ProjectList onOpenProject={onOpenProject} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() => expect(screen.queryByText("Alpha")).not.toBeInTheDocument());
    expect(deleteProject).toHaveBeenCalledWith("p1");
    expect(onOpenProject).not.toHaveBeenCalled();
  });
});
