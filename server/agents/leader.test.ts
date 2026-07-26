import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebSocketServer } from "ws";
import { createBus } from "../bus.ts";
import { getAgentType } from "./registry.ts";
import { LEADER_SYSTEM_PROMPT } from "./leader.ts";
import { disablePersistence } from "../session-persist.ts";
import { writeSettings, writeSkills } from "../project-store.ts";
import { copyValidFixture } from "../system-model/load.test.ts";
import type { TaskManagerState } from "../task-tools.ts";
import {
  LEADER_PROMPT_CORE,
  encodeLeaderPromptCustomization,
} from "../../shared/leader-prompt.ts";
import "./leader.ts";

beforeEach(() => disablePersistence());

describe("leader agent wiring", () => {
  it("documents assign_task executorClass, model override, timeout_minutes, ownedPaths, and retry in delegation guidelines", () => {
    expect(LEADER_SYSTEM_PROMPT).toContain("## Token Economy");
    expect(LEADER_SYSTEM_PROMPT).toContain("Buy conclusions, not raw data");
    expect(LEADER_SYSTEM_PROMPT).toContain("over ~2000 chars through their summaries");
    expect(LEADER_SYSTEM_PROMPT).toContain("never Read multi-thousand-line files");
    expect(LEADER_SYSTEM_PROMPT).toContain("executorClass");
    expect(LEADER_SYSTEM_PROMPT).toContain("timeout_minutes");
    expect(LEADER_SYSTEM_PROMPT).toContain("ownedPaths");
    expect(LEADER_SYSTEM_PROMPT).toMatch(/retry|re-assign/i);
    expect(LEADER_SYSTEM_PROMPT).toMatch(/model.*overrides.*executorClass/i);
  });

  it("Wait & Continue section explains early auto-wake and recommends generous durations", () => {
    // The section must explain that the system wakes the leader early when all
    // child tasks finish — so agents use long waits rather than short polling loops.
    expect(LEADER_SYSTEM_PROMPT).toMatch(/auto-wake|wakes you early/i);
    expect(LEADER_SYSTEM_PROMPT).toMatch(/10.{1,5}30 min/i);
    // The old 60-second example must no longer appear.
    expect(LEADER_SYSTEM_PROMPT).not.toMatch(/wait_and_continue.*60 seconds/i);
  });

  it("exposes task and render tools to leader sessions", () => {
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

    // Skill-authoring is opt-in: an untagged leader gets no "skills" group.
    expect(Object.keys(result.toolGroups).sort()).toEqual([
      "render-dashboard",
      "task-manager",
    ]);
    expect(result.mcpToolNames).toContain("mcp__task-manager__plan_task");
    expect(result.mcpToolNames).toContain("mcp__task-manager__load_subskill");
    expect(result.mcpToolNames).toContain("mcp__render-dashboard__render_set");
    expect(result.mcpToolNames).not.toContain("mcp__skills__create_skill");
    // The load_subskill tool def is registered under task-manager.
    expect(
      result.toolGroups["task-manager"]!.map((d) => d.name),
    ).toContain("load_subskill");
    expect(result.toolGroups["skills"]).toBeUndefined();
  });

  it("documents every registered Leader tool and keeps the allowlist exact", () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const ctx = {
      sessionKey: "leader-tools",
      cwd: "/tmp/project",
      bus,
      worktreeInfo: null,
      worktreeIsolation: false,
      startMinionSession: vi.fn(),
      scheduleWaitContinue: vi.fn(),
    };
    const leader = getAgentType("leader");
    const result = leader.getToolGroups(ctx);
    const prompt = leader.buildSystemPrompt(ctx);
    const exactRegistered = Object.entries(result.toolGroups).flatMap(([group, defs]) =>
      defs.map((def) => `mcp__${group}__${def.name}`)
    );

    expect(result.mcpToolNames).toEqual(exactRegistered);
    for (const defs of Object.values(result.toolGroups)) {
      for (const def of defs) expect(prompt).toContain(def.name);
    }
    for (const required of [
      "message_task",
      "cancel_task",
      "checkpoint_session",
      "load_subskill",
      "publish_html",
    ]) {
      expect(prompt).toContain(required);
    }
    expect(prompt).toContain('wake_on: "any_terminal"');
  });

  it("assembles the canonical core before server skills and the user prefix", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "leader-prompt-test-"));
    try {
      writeSkills(project, [{
        id: "review", name: "Review", description: "Review code",
        category: "code", icon: "*", accentColor: "#fff",
        template: "Review {{target}} carefully.", variables: [],
      }]);
      const customization = encodeLeaderPromptCustomization({
        promptPrefix: "CLIENT CUSTOMIZATION",
        skillsAddendum: "# Active Skills\n\nReview the API carefully.",
      });
      const prompt = getAgentType("leader").buildSystemPrompt({
        sessionKey: "leader-prompt",
        cwd: project,
        bus: createBus({ clients: new Set() } as unknown as WebSocketServer),
        worktreeInfo: null,
        worktreeIsolation: false,
        skillIds: ["review"],
        skillValues: { review: { target: "the API" } },
      }, customization);

      expect(prompt?.startsWith(LEADER_PROMPT_CORE)).toBe(true);
      expect(prompt).not.toBe("CLIENT CUSTOMIZATION");
      expect(prompt!.indexOf("## Your Capabilities")).toBeLessThan(
        prompt!.indexOf("# Active Skills"),
      );
      expect(prompt).toContain("Review the API carefully.");
      expect(prompt).toContain("`review` — **Review**: Review code");
      expect(prompt!.indexOf("# Active Skills")).toBeLessThan(
        prompt!.indexOf("CLIENT CUSTOMIZATION"),
      );
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("exposes the skill-authoring tools when skill-builder is tagged", () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const result = getAgentType("leader").getToolGroups({
      sessionKey: "leader-1",
      cwd: "/tmp/project",
      bus,
      worktreeInfo: null,
      worktreeIsolation: false,
      skillIds: ["skill-builder"],
      startMinionSession: vi.fn(),
      scheduleWaitContinue: vi.fn(),
    });

    expect(Object.keys(result.toolGroups).sort()).toEqual([
      "render-dashboard",
      "skills",
      "task-manager",
    ]);
    expect(result.mcpToolNames).toContain("mcp__skills__create_skill");
    // Skill-authoring tools live in their own "skills" group.
    expect(result.toolGroups["skills"]!.map((d) => d.name)).toEqual([
      "list_skills",
      "get_skill",
      "create_skill",
      "update_skill",
      "delete_skill",
    ]);
  });

  it("documents the exact registered tool set when every conditional surface is active", () => {
    const project = copyValidFixture();
    writeSettings(project, { systemModel: "advisory" });
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const ctx = {
      sessionKey: "leader-all-tools",
      cwd: project,
      bus,
      worktreeInfo: {
        path: project,
        branch: "canvas/leader-all-tools",
        leaderSessionKey: "leader-all-tools",
        createdAt: 0,
        projectPath: project,
        lifecycle: "active" as const,
      },
      worktreeIsolation: true,
      skillIds: ["skill-builder"],
      startMinionSession: vi.fn(),
      scheduleWaitContinue: vi.fn(),
    };
    const leader = getAgentType("leader");
    const result = leader.getToolGroups(ctx);
    const prompt = leader.buildSystemPrompt(ctx);
    const exactRegistered = Object.entries(result.toolGroups).flatMap(([group, defs]) =>
      defs.map((def) => `mcp__${group}__${def.name}`)
    );

    expect(result.mcpToolNames).toEqual(exactRegistered);
    for (const defs of Object.values(result.toolGroups)) {
      for (const def of defs) expect(prompt).toContain(def.name);
    }
    expect(prompt).toContain("request_approval");
    expect(prompt).toContain("create_skill");
    expect(prompt).toContain("query_system_model");
  });

  it("omits the skill-authoring tools when only other skills are tagged", () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const result = getAgentType("leader").getToolGroups({
      sessionKey: "leader-1",
      cwd: "/tmp/project",
      bus,
      worktreeInfo: null,
      worktreeIsolation: false,
      skillIds: ["code-review"],
      startMinionSession: vi.fn(),
      scheduleWaitContinue: vi.fn(),
    });

    expect(result.toolGroups["skills"]).toBeUndefined();
    expect(result.mcpToolNames).not.toContain("mcp__skills__create_skill");
  });

  it("passes Leader-selected skills and values into assign_task by default", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "leader-skills-test-"));
    try {
      writeSkills(project, [
        {
          id: "code-review",
          name: "Code Review",
          template: "Review {{target}} carefully.",
          variables: [],
        },
      ]);
      const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
      const startMinionSession = vi.fn();
      const result = getAgentType("leader").getToolGroups({
        sessionKey: "leader-1",
        cwd: project,
        bus,
        worktreeInfo: null,
        worktreeIsolation: false,
        skillIds: ["code-review"],
        skillValues: { "code-review": { target: "the API" } },
        startMinionSession,
        scheduleWaitContinue: vi.fn(),
      });
      const assignTask = result.toolGroups["task-manager"]!.find(
        (tool) => tool.name === "assign_task",
      );

      await assignTask!.handler({
        taskId: "review-api",
        title: "Review API",
        description: "Review the implementation.",
        priority: "high",
      });

      expect(startMinionSession).toHaveBeenCalledWith(expect.objectContaining({
        skillIds: ["code-review"],
        systemPrompt: expect.stringContaining("Review the API carefully."),
      }));
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("keeps flag-off tool groups and prompt byte-identical", () => {
    const project = copyValidFixture();
    writeSettings(project, { systemModel: "off" });
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const leader = getAgentType("leader");
    const beforePrompt = leader.buildSystemPrompt({
      sessionKey: "leader-1",
      cwd: project,
      bus,
      worktreeInfo: null,
      worktreeIsolation: false,
    });
    const result = leader.getToolGroups({
      sessionKey: "leader-1",
      cwd: project,
      bus,
      worktreeInfo: null,
      worktreeIsolation: false,
      startMinionSession: vi.fn(),
      scheduleWaitContinue: vi.fn(),
    });
    const afterPrompt = leader.buildSystemPrompt({
      sessionKey: "leader-1",
      cwd: project,
      bus,
      worktreeInfo: null,
      worktreeIsolation: false,
    });

    expect(Object.keys(result.toolGroups).sort()).toEqual([
      "render-dashboard",
      "task-manager",
    ]);
    expect(result.mcpToolNames).not.toContain("mcp__system-model__query_system_model");
    expect(afterPrompt).toBe(beforePrompt);
  });

  it("registers system-model tools when flag and manifest are present", () => {
    const project = copyValidFixture();
    writeSettings(project, { systemModel: "advisory" });
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const result = getAgentType("leader").getToolGroups({
      sessionKey: "leader-1",
      cwd: project,
      bus,
      worktreeInfo: null,
      worktreeIsolation: false,
      startMinionSession: vi.fn(),
      scheduleWaitContinue: vi.fn(),
    });

    expect(result.toolGroups["system-model"]?.map((def) => def.name)).toEqual([
      "query_system_model",
      "create_work_packet",
      "amend_work_packet",
      "check_freshness",
      "record_verification",
      "reconcile_run",
      "record_constraint_verdicts",
      "model_health",
    ]);
    expect(result.mcpToolNames).toContain("mcp__system-model__query_system_model");
    expect(result.mcpToolNames).toContain("mcp__system-model__create_work_packet");
  });

  it("appends the system-model leader prompt addendum only when active", () => {
    const project = copyValidFixture();
    writeSettings(project, { systemModel: "advisory" });
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const prompt = getAgentType("leader").buildSystemPrompt({
      sessionKey: "leader-1",
      cwd: project,
      bus,
      worktreeInfo: null,
      worktreeIsolation: false,
    });

    expect(prompt).toContain("## System Model");
    expect(prompt).toContain("create_work_packet");
    expect(prompt).toContain("workPacketId");
    // Redesign §6: the addendum lists the concrete gated surfaces …
    expect(prompt).toContain("Gated surfaces");
    expect(prompt).toContain("server/**/*.ts");
    // … and no longer mandates querying the model for general planning.
    expect(prompt).not.toContain("planning context");
    expect(prompt).toContain("available, not mandated");
  });

  it("ends a truncated system-model addendum with a query recovery pointer", () => {
    const project = copyValidFixture();
    writeSettings(project, { systemModel: "advisory" });
    fs.writeFileSync(
      path.join(project, ".systemmodel/policies/context-budgets.yaml"),
      "leaderPromptAddendum: 20\nminionContextPack: 2000\nperObjectSummary: 250\n",
    );
    const prompt = getAgentType("leader").buildSystemPrompt({
      sessionKey: "leader-truncated",
      cwd: project,
      bus: createBus({ clients: new Set() } as unknown as WebSocketServer),
      worktreeInfo: null,
      worktreeIsolation: false,
    });

    expect(prompt).toContain("system-model addendum truncated");
    expect(prompt).toContain("use `query_system_model` to fetch omitted objects");
    expect(prompt?.endsWith(
      "[system-model addendum truncated — use `query_system_model` to fetch omitted objects]",
    )).toBe(true);
  });

  // Regression (2026-06): the child-task sweep used to live in `onComplete`,
  // which fires on EVERY `done` event — i.e. every time the leader ends a
  // turn. Assigning minions and then pausing (wait_and_continue) aborted all
  // running minions the moment the leader's turn completed. The sweep now
  // lives in `onTerminate`, gated to close/remove.
  it("does not cancel running child tasks when a leader run completes", () => {
    expect(getAgentType("leader").onComplete).toBeUndefined();
  });

  it("keeps children running when the leader is merely stopped or its run aborted", () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const taskState = makeTaskStateWithChildren();
    const terminations: Array<[string, string]> = [];
    const ctx = {
      sessionKey: "leader-1",
      cwd: "/tmp/project",
      bus,
      worktreeInfo: null,
      worktreeIsolation: false,
      terminateSession: (sessionKey: string, reason: string) =>
        terminations.push([sessionKey, reason]),
      forEachLeaderTaskState: (
        fn: (leaderKey: string, state: TaskManagerState) => void,
      ) => fn("leader-1", taskState),
    };

    getAgentType("leader").onTerminate?.(ctx, "stop");
    getAgentType("leader").onTerminate?.(ctx, "abort");

    expect(taskState.tasks.get("running-child")?.status).toBe("running");
    expect(terminations).toEqual([]);
  });

  it("cancels unfinished child tasks when the leader session is closed or removed", () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const envelopes: Array<Record<string, unknown>> = [];
    bus.subscribe((envelope) => envelopes.push(envelope));
    const taskState = makeTaskStateWithChildren();
    const terminations: Array<[string, string]> = [];

    getAgentType("leader").onTerminate?.(
      {
        sessionKey: "leader-1",
        cwd: "/tmp/project",
        bus,
        worktreeInfo: null,
        worktreeIsolation: false,
        terminateSession: (sessionKey: string, reason: string) =>
          terminations.push([sessionKey, reason]),
        forEachLeaderTaskState: (
          fn: (leaderKey: string, state: TaskManagerState) => void,
        ) => fn("leader-1", taskState),
      },
      "remove",
    );

    expect(taskState.tasks.get("running-child")?.status).toBe("cancelled");
    expect(taskState.tasks.get("done-child")?.status).toBe("completed");
    expect(terminations).toEqual([["minion-1", "abort"]]);
    expect(envelopes.some((e) => e.type === "task_plan_update")).toBe(true);
  });
});

function makeTaskStateWithChildren(): TaskManagerState {
  return {
    tasks: new Map([
      [
        "running-child",
        {
          taskId: "running-child",
          title: "Running child",
          description: "",
          priority: "medium" as const,
          executor: "minion" as const,
          minionSessionKey: "minion-1",
          leaderSessionKey: "leader-1",
          status: "running" as const,
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
          priority: "medium" as const,
          executor: "minion" as const,
          minionSessionKey: "minion-2",
          leaderSessionKey: "leader-1",
          status: "completed" as const,
          createdAt: Date.now(),
          completedAt: Date.now(),
          result: "ok",
        },
      ],
    ]),
    pendingWait: null,
    approval: null,
  };
}
