import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BusPayload } from "../bus.ts";
import type { TaskToolContext } from "./types.ts";
import { createUpdateProjectContextToolDef } from "./update-project-context.ts";
import { writeContext } from "../project-store.ts";

vi.mock("../project-store.ts", () => ({ writeContext: vi.fn() }));
vi.mock("../workspace-registry.ts", () => ({
  findWorkspaceBySource: vi.fn(() => ({ id: "workspace-1" })),
}));

describe("update_project_context", () => {
  const emitted: Array<{ projectId: string; payload: BusPayload }> = [];
  const ctx = {
    leaderSessionKey: "leader-1",
    projectPath: "/source/project",
    cwd: "/worktree/project",
    bus: {
      emit: vi.fn(),
      emitToSession: vi.fn(),
      emitToProject: (projectId: string, payload: BusPayload) => emitted.push({ projectId, payload }),
      emitGlobal: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    },
    startMinionSession: vi.fn(),
    minionSystemPrompt: "",
    taskState: { tasks: new Map(), pendingWait: null, approval: null },
    scheduleWaitContinue: vi.fn(),
  } satisfies TaskToolContext;

  beforeEach(() => {
    emitted.length = 0;
    vi.mocked(writeContext).mockClear();
  });

  it("writes workspace-owned context and publishes the live project update", async () => {
    const tool = createUpdateProjectContextToolDef(ctx);
    await tool.handler({ content: "  # Architecture\n\nUse the typed bus.  " });

    expect(writeContext).toHaveBeenCalledWith(
      "/source/project",
      "# Architecture\n\nUse the typed bus.",
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      projectId: "workspace-1",
      payload: {
        type: "project_context_updated",
        projectId: "workspace-1",
        content: "# Architecture\n\nUse the typed bus.",
        exists: true,
        updatedBySessionKey: "leader-1",
      },
    });
  });

  it("rejects empty context without writing or broadcasting", async () => {
    const tool = createUpdateProjectContextToolDef(ctx);
    await expect(tool.handler({ content: "   " })).rejects.toThrow();
    expect(writeContext).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });
});
