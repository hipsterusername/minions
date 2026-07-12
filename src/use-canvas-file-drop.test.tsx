import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCanvasFileDrop } from "./use-canvas-file-drop.ts";
import { createImageNodeFromProjectPath } from "./nodes/image-node-factory.ts";

vi.mock("./canvas-state.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./canvas-state.ts")>()),
  generateId: vi.fn(() => "generated-node"),
}));

vi.mock("./node-registry.ts", () => ({
  getAllNodeTypes: () => [
    { type: "folder", defaultSize: { width: 300, height: 200 } },
    { type: "file-viewer", defaultSize: { width: 400, height: 300 } },
    { type: "note", defaultSize: { width: 220, height: 160 } },
  ],
}));

vi.mock("./nodes/image-node-factory.ts", () => ({
  createImageNodeFromFile: vi.fn(async () => true),
  createImageNodeFromProjectPath: vi.fn(async () => true),
}));

function dragEvent(
  entries: Record<string, string>,
  types = Object.keys(entries),
): React.DragEvent {
  return {
    clientX: 250,
    clientY: 180,
    preventDefault: vi.fn(),
    dataTransfer: {
      types,
      files: [],
      dropEffect: "none",
      getData: (type: string) => entries[type] ?? "",
    },
  } as unknown as React.DragEvent;
}

function setup() {
  const dispatch = vi.fn();
  const setSelectedIds = vi.fn();
  const container = document.createElement("div");
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
    x: 10, y: 20, left: 10, top: 20, right: 810, bottom: 620,
    width: 800, height: 600, toJSON: () => ({}),
  });
  const options = {
    dispatch,
    setSelectedIds,
    containerRef: { current: container },
    transformRef: { current: { x: 40, y: 20, scale: 2 } },
    nodesRef: { current: [] },
    projectPath: "/repo",
  };
  const hook = renderHook(() => useCanvasFileDrop(options));
  return { ...hook, dispatch, setSelectedIds };
}

describe("useCanvasFileDrop", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps the drag overlay active across nested enter/leave events", () => {
    const { result } = setup();
    const event = dragEvent({}, ["Files"]);

    act(() => {
      result.current.handleDragEnter(event);
      result.current.handleDragEnter(event);
    });
    expect(result.current.isDragOverCanvas).toBe(true);

    act(() => result.current.handleDragLeave(event));
    expect(result.current.isDragOverCanvas).toBe(true);
    act(() => result.current.handleDragLeave(event));
    expect(result.current.isDragOverCanvas).toBe(false);
  });

  it("creates and selects a folder node at the transformed drop point", async () => {
    const { result, dispatch, setSelectedIds } = setup();
    const event = dragEvent({
      "application/x-tree-path": "src/components",
      "application/x-tree-type": "dir",
    });

    await act(() => result.current.handleFileDrop(event));

    expect(dispatch).toHaveBeenCalledWith({
      type: "ADD_NODE",
      node: expect.objectContaining({
        id: "generated-node",
        type: "folder",
        position: { x: -48, y: -24 },
        data: expect.objectContaining({ folderPath: "src/components", collapsed: false }),
      }),
    });
    expect(setSelectedIds).toHaveBeenCalledWith(new Set(["generated-node"]));
  });

  it("routes project-tree images through the image-node producer", async () => {
    const { result, dispatch } = setup();
    const event = dragEvent({
      "application/x-tree-path": "assets/logo.png",
      "application/x-tree-type": "file",
    });

    await act(() => result.current.handleFileDrop(event));

    expect(createImageNodeFromProjectPath).toHaveBeenCalledWith(
      "/repo",
      "assets/logo.png",
      dispatch,
      expect.any(Function),
      { x: 40, y: 20, scale: 2 },
      [],
      { x: 100, y: 70 },
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("falls back to a file viewer when image loading fails", async () => {
    vi.mocked(createImageNodeFromProjectPath).mockResolvedValueOnce(false);
    const { result, dispatch } = setup();
    const event = dragEvent({
      "application/x-tree-path": "assets/broken.png",
      "application/x-tree-type": "file",
    });

    await act(() => result.current.handleFileDrop(event));

    expect(dispatch).toHaveBeenCalledWith({
      type: "ADD_NODE",
      node: expect.objectContaining({
        type: "file-viewer",
        data: { filePath: "assets/broken.png", collapsed: false, expandedHeight: 420 },
      }),
    });
  });
});
