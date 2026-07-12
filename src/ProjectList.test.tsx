import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectList } from "./ProjectList.tsx";
import {
  createProject,
  deleteProject,
  getHarnessReadiness,
  listProjects,
  openProject,
} from "./api.ts";

vi.mock("./api.ts", () => ({
  listProjects: vi.fn(),
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
    vi.mocked(listProjects).mockResolvedValue([project]);
    vi.mocked(getHarnessReadiness).mockResolvedValue(ready);
    vi.mocked(openProject).mockResolvedValue({ ...project, transform: { x: 0, y: 0, scale: 1 }, createdAt: "", updatedAt: "", nodes: [] });
    vi.mocked(createProject).mockResolvedValue({ ...project, transform: { x: 0, y: 0, scale: 1 }, createdAt: "", updatedAt: "", nodes: [] });
    vi.mocked(deleteProject).mockResolvedValue({});
  });

  it("opens a recent project without issuing a second server request", async () => {
    const onOpenProject = vi.fn();
    render(<ProjectList onOpenProject={onOpenProject} />);

    fireEvent.click(await screen.findByText("Alpha"));

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
