import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App, { formatProjectDocumentTitle } from "./App.tsx";
import { getProject, listProjects, updateProject } from "./api.ts";
import { useLeaderFullscreenRequest } from "./use-leader-fullscreen-request.ts";
import type { ActivityViewProps } from "./ActivityView.tsx";

vi.mock("./nodes/ClaudeSessionNode.tsx", () => ({}));
vi.mock("./nodes/LeaderNode.tsx", () => ({}));
vi.mock("./nodes/MinionNode.tsx", () => ({}));
vi.mock("./nodes/MarkdownNode.tsx", () => ({}));
vi.mock("./nodes/FileViewerNode.tsx", () => ({}));
vi.mock("./nodes/FolderNode.tsx", () => ({}));
vi.mock("./nodes/ContextGroupNode.tsx", () => ({}));
vi.mock("./nodes/RenderNode.tsx", () => ({}));
vi.mock("./nodes/ImageNode.tsx", () => ({}));

vi.mock("./api.ts", () => ({
  listProjects: vi.fn(),
  createProject: vi.fn(),
  openProject: vi.fn(),
  deleteProject: vi.fn(),
  getProject: vi.fn(),
  updateProject: vi.fn(),
  updateProjectSettings: vi.fn(),
  saveProjectState: vi.fn(),
  getAuthToken: vi.fn(async () => "token"),
  clearAuthToken: vi.fn(),
  getHarnessReadiness: vi.fn(async () => ({ schemaVersion: 1, checkedAt: "", expiresAt: "", ready: true, readyHarnesses: ["claude"], harnesses: [] })),
}));

vi.mock("./use-socket.ts", () => ({
  useSocket: () => ({
    connected: false,
    send: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  }),
}));

vi.mock("./use-autosave.ts", () => ({
  useAutosave: () => ({
    status: "idle",
    lastSaved: null,
    retryCount: 0,
    retry: vi.fn(),
  }),
}));

vi.mock("./ProjectHeader.tsx", () => ({
  ProjectHeader: ({
    name,
    onRename,
    onBack,
    onSwitchProject,
    onViewChange,
  }: {
    name: string;
    onRename: (name: string) => void;
    onBack: () => void;
    onSwitchProject: (id: string, path: string) => void;
    onViewChange: (view: string) => void;
  }) => (
    <div>
      <h1>{name}</h1>
      <button onClick={() => onRename("Beta Project")}>Rename Project</button>
      <button onClick={onBack}>Back To Projects</button>
      <button onClick={() => onSwitchProject("project-2", "/tmp/beta")}>Switch To Beta</button>
      <button onClick={() => onViewChange("canvas")}>Go To Canvas</button>
    </div>
  ),
}));


vi.mock("./Canvas.tsx", () => ({
  Canvas: () => {
    const [fullscreen, setFullscreen] = useState(false);
    const returnRef = useRef<(() => void) | undefined>(undefined);
    useLeaderFullscreenRequest("leader-1", onExit => {
      returnRef.current = onExit;
      setFullscreen(true);
    });
    return <div>Canvas{fullscreen && <button onClick={() => {
      setFullscreen(false);
      returnRef.current?.();
    }}>Exit fullscreen</button>}</div>;
  },
}));

vi.mock("./ActivityView.tsx", () => ({
  ActivityView: ({ initialSelectedKey, onExpandFullscreen }: ActivityViewProps) => (
    <div data-testid="activity-view">
      <span>{initialSelectedKey}</span>
      <button onClick={() => onExpandFullscreen("leader-1", "work-item:work-1")}>Expand fullscreen</button>
    </div>
  ),
}));

vi.mock("./ProjectPanel.tsx", () => ({
  ProjectPanel: () => null,
}));

vi.mock("./SkillsBrowser.tsx", () => ({
  SkillsBrowser: () => null,
}));

vi.mock("./McpServersBrowser.tsx", () => ({
  McpServersBrowser: () => <div data-testid="mcp-browser" />,
}));

vi.mock("./SkillEditor.tsx", () => ({
  SkillEditor: () => null,
}));

vi.mock("./BottomRightDock.tsx", () => ({
  DockProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  DockBar: () => null,
  SkillsNavButton: () => null,
}));

vi.mock("./LeaderLoadingScreen.tsx", () => ({
  LeaderLoadingScreen: () => null,
}));

vi.mock("./components/DebugModeAffordance.tsx", () => ({
  DebugModeAffordance: () => null,
}));

describe("App document title", () => {
  beforeEach(() => {
    vi.mocked(listProjects).mockResolvedValue([
      {
        id: "project-1",
        path: "/tmp/alpha",
        name: "Recent Alpha",
        lastOpened: new Date().toISOString(),
        hasSidecar: true,
      },
    ]);
    vi.mocked(getProject).mockResolvedValue({
      id: "project-1",
      path: "/tmp/alpha",
      name: "Alpha Project",
      transform: { x: 0, y: 0, scale: 1 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [],
      graph: { edges: [] },
      settings: {},
      skills: [],
    });
    vi.mocked(updateProject).mockResolvedValue({});
    document.title = "Minions";
  });

  it("formats project titles", () => {
    expect(formatProjectDocumentTitle("Alpha Project")).toBe(
      "Alpha Project (Minions)",
    );
    expect(formatProjectDocumentTitle("   ")).toBe("Minions");
  });

  it("returns from fullscreen to the selected Activity entry on repeated visits", async () => {
    const project = await getProject("project-1");
    vi.mocked(getProject).mockResolvedValue({ ...project, nodes: [{
      id: "leader-1", type: "leader", position: { x: 0, y: 0 },
      size: { width: 560, height: 520 }, data: {},
    }] });
    render(<App />);
    fireEvent.click(await screen.findByText("Recent Alpha"));

    for (let visit = 0; visit < 2; visit++) {
      fireEvent.click(await screen.findByRole("button", { name: "Expand fullscreen" }));
      expect(screen.queryByTestId("activity-view")).toBeNull();
      fireEvent.click(await screen.findByRole("button", { name: "Exit fullscreen" }));
      expect(await screen.findByTestId("activity-view")).toHaveTextContent("work-item:work-1");
      expect(screen.queryByText("Canvas")).toBeNull();
    }

    fireEvent.click(screen.getByRole("button", { name: "Go To Canvas" }));
    expect(screen.getByText("Canvas")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Exit fullscreen" })).toBeNull();
  });

  it("tracks the selected project name and resets when closed", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("Recent Alpha"));

    await waitFor(() => {
      expect(document.title).toBe("Alpha Project (Minions)");
    });

    fireEvent.click(screen.getByRole("button", { name: "Rename Project" }));
    expect(document.title).toBe("Beta Project (Minions)");
    expect(updateProject).toHaveBeenCalledWith("project-1", {
      name: "Beta Project",
    });

    fireEvent.click(screen.getByRole("button", { name: "Back To Projects" }));
    expect(document.title).toBe("Minions");
  });

  it("loads a project selected from the header switcher", async () => {
    vi.mocked(getProject).mockImplementation(async (id) => ({
      id,
      path: id === "project-2" ? "/tmp/beta" : "/tmp/alpha",
      name: id === "project-2" ? "Beta Project" : "Alpha Project",
      transform: { x: 0, y: 0, scale: 1 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [],
      graph: { edges: [] },
      settings: {},
      skills: [],
    }));
    render(<App />);

    fireEvent.click(await screen.findByText("Recent Alpha"));
    await waitFor(() => expect(document.title).toBe("Alpha Project (Minions)"));
    fireEvent.click(screen.getByRole("button", { name: "Switch To Beta" }));

    await waitFor(() => {
      expect(getProject).toHaveBeenCalledWith("project-2");
      expect(document.title).toBe("Beta Project (Minions)");
    });
  });
});

describe("MCP servers feature flag gating", () => {
  const FLAGS_KEY = "minions:feature-flags";

  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(listProjects).mockResolvedValue([
      {
        id: "project-1",
        path: "/tmp/alpha",
        name: "Recent Alpha",
        lastOpened: new Date().toISOString(),
        hasSidecar: true,
      },
    ]);
    vi.mocked(getProject).mockResolvedValue({
      id: "project-1",
      path: "/tmp/alpha",
      name: "Alpha Project",
      transform: { x: 0, y: 0, scale: 1 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [],
      graph: { edges: [] },
      settings: {},
      skills: [],
    });
    vi.mocked(updateProject).mockResolvedValue({});
  });

  // The MCP browser only mounts in the canvas view's dock, so drive the
  // app into that view before asserting on the flag gate.
  async function openProjectCanvas() {
    render(<App />);
    fireEvent.click(await screen.findByText("Recent Alpha"));
    fireEvent.click(await screen.findByRole("button", { name: "Go To Canvas" }));
  }

  it("does not mount the MCP browser by default (flag off)", async () => {
    await openProjectCanvas();
    // SkillsBrowser mounts unconditionally in the same dock; wait for the
    // canvas tree, then assert the gated browser is absent.
    await waitFor(() => expect(screen.getByText("Canvas")).toBeInTheDocument());
    expect(screen.queryByTestId("mcp-browser")).toBeNull();
  });

  it("mounts the MCP browser when the flag is enabled", async () => {
    window.localStorage.setItem(
      FLAGS_KEY,
      JSON.stringify({ "mcp-servers": true }),
    );
    await openProjectCanvas();
    expect(await screen.findByTestId("mcp-browser")).toBeInTheDocument();
  });
});
