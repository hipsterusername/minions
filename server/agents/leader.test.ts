import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocketServer } from "ws";
import { createBus } from "../bus.ts";
import { getAgentType } from "./registry.ts";
import { LEADER_SYSTEM_PROMPT } from "./leader.ts";
import { disablePersistence } from "../session-persist.ts";
import type { TaskManagerState } from "../task-tools.ts";
import "./leader.ts";

beforeEach(() => disablePersistence());

describe("leader agent reasoning map wiring", () => {
  it("documents reasoning graph constraints in the prompt", () => {
    expect(LEADER_SYSTEM_PROMPT).toContain("create_reasoning_map");
    expect(LEADER_SYSTEM_PROMPT).toContain("Every hypothesis must include `falsifiedBy`");
    expect(LEADER_SYSTEM_PROMPT).toContain("Do not expose private chain-of-thought");
  });

  it("exposes reasoning map tools to leader sessions", () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const result = getAgentType("leader").getToolGroups({
      sessionKey: "leader-1",
      cwd: "/tmp/project",
      bus,
      worktreeInfo: null,
      worktreeIsolation: false,
      startMinionSession: vi.fn(),
      scheduleWaitContinue: vi.fn(),
    });

    expect(Object.keys(result.toolGroups)).toContain("reasoning-map");
    expect(result.mcpToolNames).toContain(
      "mcp__reasoning-map__create_reasoning_map",
    );
    expect(result.reasoningMapState).toEqual({ maps: [] });
  });

  it("publishes reasoning graph state into the dashboard side panel", async () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const envelopes: Array<Record<string, unknown>> = [];
    bus.subscribe((envelope) => envelopes.push(envelope));
    const result = getAgentType("leader").getToolGroups({
      sessionKey: "leader-1",
      cwd: "/tmp/project",
      bus,
      worktreeInfo: null,
      worktreeIsolation: false,
      startMinionSession: vi.fn(),
      scheduleWaitContinue: vi.fn(),
    });

    const createMap = result.toolGroups["reasoning-map"]!.find(
      (tool) => tool.name === "create_reasoning_map",
    )!;
    await createMap.handler({
      title: "Risky refactor",
      outcome: {
        title: "Refactor safely",
        summary: "Keep behavior while changing structure.",
        successSignal: "Focused tests pass.",
      },
    });

    expect(result.renderState?.components).toContainEqual(
      expect.objectContaining({
        id: "reasoning-map-dashboard",
        type: "section",
        title: "Reasoning Graph",
      }),
    );
    expect(envelopes).toContainEqual(
      expect.objectContaining({
        type: "render_update",
        leaderSessionKey: "leader-1",
        action: "append",
        components: [
          expect.objectContaining({
            id: "reasoning-map-dashboard",
            type: "section",
          }),
        ],
      }),
    );
  });

  it("cancels unfinished child tasks when the leader completes", async () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const envelopes: Array<Record<string, unknown>> = [];
    bus.subscribe((envelope) => envelopes.push(envelope));
    const taskState: TaskManagerState = {
      tasks: new Map([
        [
          "running-child",
          {
            taskId: "running-child",
            title: "Running child",
            description: "",
            priority: "medium",
            executor: "minion",
            minionSessionKey: "minion-1",
            leaderSessionKey: "leader-1",
            status: "running",
            createdAt: Date.now(),
            completedAt: null,
            result: null,
          },
        ],
        [
          "done-child",
          {
            taskId: "done-child",
            title: "Done child",
            description: "",
            priority: "medium",
            executor: "minion",
            minionSessionKey: "minion-2",
            leaderSessionKey: "leader-1",
            status: "completed",
            createdAt: Date.now(),
            completedAt: Date.now(),
            result: "ok",
          },
        ],
      ]),
      pendingWait: null,
      approval: null,
    };
    const terminations: Array<[string, string]> = [];

    await getAgentType("leader").onComplete?.(
      {
        sessionKey: "leader-1",
        cwd: "/tmp/project",
        bus,
        worktreeInfo: null,
        worktreeIsolation: false,
        terminateSession: (sessionKey, reason) =>
          terminations.push([sessionKey, reason]),
        forEachLeaderTaskState: (fn) => fn("leader-1", taskState),
      },
      {},
    );

    expect(taskState.tasks.get("running-child")?.status).toBe("cancelled");
    expect(taskState.tasks.get("done-child")?.status).toBe("completed");
    expect(terminations).toEqual([["minion-1", "abort"]]);
    expect(envelopes.some((e) => e.type === "task_plan_update")).toBe(true);
  });
});
