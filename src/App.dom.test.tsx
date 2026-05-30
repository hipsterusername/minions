import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App, { formatProjectDocumentTitle } from "./App.tsx";
import { getProject, listProjects, updateProject } from "./api.ts";

vi.mock("./nodes/ClaudeSessionNode.tsx", () => ({}));
vi.mock("./nodes/LeaderNode.tsx", () => ({}));
vi.mock("./nodes/MinionNode.tsx", () => ({}));
vi.mock("./nodes/MarkdownNode.tsx", () => ({}));
vi.mock("./nodes/FileViewerNode.tsx", () => ({}));
vi.mock("./nodes/FolderNode.tsx", () => ({}));
vi.mock("./nodes/ContextGroupNode.tsx", () => ({}));
vi.mock("./nodes/RenderNode.tsx", () => ({}));
vi.mock("./nodes/ImageNode.tsx", () => ({}));
vi.mock("./nodes/RoutineNode.tsx", () => ({}));

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
  }: {
    name: string;
    onRename: (name: string) => void;
    onBack: () => void;
  }) => (
    <div>
      <h1>{name}</h1>
      <button onClick={() => onRename("Beta Project")}>Rename Project</button>
      <button onClick={onBack}>Back To Projects</button>
    </div>
  ),
}));

vi.mock("./KanbanBoard.tsx", () => ({
  KanbanBoard: () => <div>Kanban</div>,
}));

vi.mock("./Canvas.tsx", () => ({
  Canvas: () => <div>Canvas</div>,
}));

vi.mock("./ProjectPanel.tsx", () => ({
  ProjectPanel: () => null,
}));

vi.mock("./SkillsBrowser.tsx", () => ({
  SkillsBrowser: () => null,
}));

vi.mock("./McpServersBrowser.tsx", () => ({
  McpServersBrowser: () => null,
}));

vi.mock("./SkillEditor.tsx", () => ({
  SkillEditor: () => null,
}));

vi.mock("./RoutineEditor.tsx", () => ({
  RoutineEditor: () => null,
}));

vi.mock("./BottomRightDock.tsx", () => ({
  DockProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  DockBar: () => null,
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
});
