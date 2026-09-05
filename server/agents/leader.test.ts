import { saveSkillSnapshot } from "../skill-snapshot.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
import { ROLE_SYSTEM_PROMPT } from "../../shared/prompts/role-system.ts";
import type { TaskGraphPlanningCoordinator } from "../task-graph/planning-coordinator.ts";
import "./leader.ts";

beforeEach(() => disablePersistence());

describe("leader agent wiring", () => {
  it("keeps legacy delegation guidance behind the direct-mode prompt", () => {
    const prompt = getAgentType("leader").buildSystemPrompt({
      sessionKey: "legacy-prompt",
      cwd: "/tmp/project",
      bus: createBus({ clients: new Set() } as unknown as WebSocketServer),
      worktreeInfo: null,
      worktreeIsolation: false,
      orchestrationMode: "direct",
    });
    expect(prompt).toContain("## Token Economy");
    expect(prompt).toContain("Buy conclusions, not raw data");
    expect(prompt).toContain("over ~2000 chars through their summaries");
    expect(prompt).toMatch(/never read multi-thousand-line files/i);
    expect(prompt).toContain("## Legacy planning mode (debug)");
    expect(prompt).toContain("executorClass");
    expect(prompt).toContain("timeout_minutes");
    expect(prompt).toContain("ownedPaths");
    expect(prompt).toMatch(/retry|re-assign/i);
    expect(prompt).toMatch(/model.*overrides.*executorClass/i);
    expect(prompt).not.toContain("## Task Graph planning");
  });

  it("keeps direct controls available without copying legacy-mode prose into the graph prompt", () => {
    expect(LEADER_SYSTEM_PROMPT).toContain("## Task Graph planning");
    expect(LEADER_SYSTEM_PROMPT).not.toContain("## Legacy planning mode (debug)");
    expect(LEADER_SYSTEM_PROMPT).toContain("wait_and_continue");
    expect(LEADER_SYSTEM_PROMPT).toMatch(/optional reasoning and orchestration aid/i);
    const legacyPrompt = getAgentType("leader").buildSystemPrompt({
      sessionKey: "legacy-wait-prompt",
      cwd: "/tmp/project",
      bus: createBus({ clients: new Set() } as unknown as WebSocketServer),
      worktreeInfo: null,
      worktreeIsolation: false,
      orchestrationMode: "direct",
    });
    // The section must explain that the system wakes the leader early when all
    // child tasks finish — so agents use long waits rather than short polling loops.
    expect(legacyPrompt).toMatch(/auto-wake|wakes you early/i);
    expect(legacyPrompt).toMatch(/10.{1,5}30 min/i);
    // The old 60-second example must no longer appear.
    expect(legacyPrompt).not.toMatch(/wait_and_continue.*60 seconds/i);
  });

  it("advertises only effective named tools and describes unnamed native filesystem capability", () => {
    const prompt = getAgentType("leader").buildSystemPrompt({
      sessionKey: "restricted", cwd: "/tmp/project", bus: createBus({ clients: new Set() } as unknown as WebSocketServer),
      worktreeInfo: null, worktreeIsolation: false,
      effectiveCapabilities: { allowedTools: ["mcp__leader-procedures__load_procedure"],
        nativeFilesystem: true, filesystemScope: "read-only", approvalPolicy: "never" },
    }, undefined, []);
    expect(prompt).toContain("Native shell/filesystem capabilities");
    expect(prompt).toContain("Filesystem policy: read-only; approval policy: never");
    expect(prompt).toContain("**mcp__leader-procedures__load_procedure**");
    expect(prompt).not.toContain("**assign_task**");
    expect(prompt).not.toContain("Built-in tools: (none");
    expect(prompt).not.toContain("p18.double_diamond");
  });

  it("exposes task, procedure and render tools to leader sessions", async () => {
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
      "leader-procedures",
      "render-dashboard",
      "task-manager",
    ]);
    expect(result.mcpToolNames).toContain("mcp__task-manager__plan_task");
    expect(result.mcpToolNames).toContain("mcp__task-manager__load_subskill");
    expect(result.mcpToolNames).toContain("mcp__task-manager__update_project_context");
    expect(result.mcpToolNames).toContain("mcp__render-dashboard__render_set");
    const procedure = result.toolGroups["leader-procedures"]![0]!;
    expect(JSON.stringify(await procedure.handler({ id: "graph_authoring" }))).toContain("p18.double_diamond");
    expect(result.mcpToolNames).not.toContain("mcp__skills__create_skill");
    // The load_subskill tool def is registered under task-manager.
    expect(
      result.toolGroups["task-manager"]!.map((d) => d.name),
    ).toContain("load_subskill");
    expect(result.toolGroups["skills"]).toBeUndefined();
  });

  it("adds graph planning alongside direct tools for graph-mode primary Leaders", () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const ctx = {
      sessionKey: "leader-graph", runKey: "primary", workItemId: "work",
      cwd: "/tmp/project", bus, worktreeInfo: null, worktreeIsolation: false,
      startMinionSession: vi.fn(), scheduleWaitContinue: vi.fn(),
      orchestrationMode: "plan" as const,
      taskGraphPlanning: {} as TaskGraphPlanningCoordinator,
    };
    const leader = getAgentType("leader");
    const result = leader.getToolGroups(ctx);
    const taskNames = result.toolGroups["task-manager"]!.map((tool) => tool.name);
    const graphNames = result.toolGroups["graph-planner"]!.map((tool) => tool.name);

    expect(taskNames).toEqual([
      "plan_task", "assign_task", "complete_task", "cancel_task", "message_task",
      "get_task_status", "set_task_name", "wait_and_continue", "checkpoint_session",
      "load_skill", "load_subskill", "load_skill_attachment", "update_project_context",
    ]);
    expect(graphNames).toEqual([
      "initialize_graph_document", "upsert_graph_node", "remove_graph_node",
      "upsert_graph_edge", "remove_graph_edge", "get_graph_document", "submit_graph_document",
      "submit_graph_plan", "submit_dialectic_graph", "get_graph_plan", "start_graph_plan",
      "read_graph_artifact", "cancel_graph_run", "moderate_dialectic", "adjudicate_graph_node",
    ]);
    expect(result.mcpToolNames).toContain("mcp__task-manager__plan_task");
    expect(result.mcpToolNames).toContain("mcp__task-manager__assign_task");
    expect(leader.buildSystemPrompt(ctx)).toContain("## Task Graph planning");
    expect(leader.buildSystemPrompt(ctx)).not.toContain("## Legacy planning mode (debug)");
  });

  it("defaults canonical Leaders without a persisted mode to Task Graph", () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const ctx = {
      sessionKey: "leader-default-graph", runKey: "primary", workItemId: "work",
      cwd: "/tmp/project", bus, worktreeInfo: null, worktreeIsolation: false,
      startMinionSession: vi.fn(), scheduleWaitContinue: vi.fn(),
      taskGraphPlanning: {} as TaskGraphPlanningCoordinator,
    };
    const leader = getAgentType("leader");
    const result = leader.getToolGroups(ctx);
    const taskNames = result.toolGroups["task-manager"]!.map((tool) => tool.name);

    expect(taskNames).toEqual([
      "plan_task", "assign_task", "complete_task", "cancel_task", "message_task",
      "get_task_status", "set_task_name", "wait_and_continue", "checkpoint_session",
      "load_skill", "load_subskill", "load_skill_attachment", "update_project_context",
    ]);
    expect(result.toolGroups["graph-planner"]!.map((tool) => tool.name)).toEqual([
      "initialize_graph_document", "upsert_graph_node", "remove_graph_node",
      "upsert_graph_edge", "remove_graph_edge", "get_graph_document", "submit_graph_document",
      "submit_graph_plan", "submit_dialectic_graph", "get_graph_plan", "start_graph_plan",
      "read_graph_artifact", "cancel_graph_run", "moderate_dialectic", "adjudicate_graph_node",
    ]);
    expect(result.mcpToolNames).toContain("mcp__task-manager__plan_task");
    expect(leader.buildSystemPrompt(ctx)).toMatch(/Task Graph is an optional/i);
    expect(leader.buildSystemPrompt(ctx)).toContain("- **plan_task**");
  });

  it("switches a canonical Leader's prompt and tools together in legacy debug mode", () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const ctx = {
      sessionKey: "leader-legacy-debug", runKey: "primary", workItemId: "work",
      cwd: "/tmp/project", bus, worktreeInfo: null, worktreeIsolation: false,
      startMinionSession: vi.fn(), scheduleWaitContinue: vi.fn(),
      orchestrationMode: "direct" as const,
    };
    const leader = getAgentType("leader");
    const result = leader.getToolGroups(ctx);
    const prompt = leader.buildSystemPrompt(ctx);
    const taskNames = result.toolGroups["task-manager"]!.map((tool) => tool.name);

    expect(taskNames).toContain("plan_task");
    expect(taskNames).toContain("assign_task");
    expect(result.toolGroups["graph-planner"]).toBeUndefined();
    expect(prompt).toContain("## Legacy planning mode (debug)");
    expect(prompt).toContain("- **plan_task**");
    expect(prompt).not.toContain("## Task Graph planning");
    expect(prompt).not.toContain("- **submit_graph_plan**");
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
      "update_project_context",
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

  it("assembles selected instructions and the catalog from the retrieval snapshot", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "leader-frozen-skill-"));
    try {
      const skillSnapshotId = saveSkillSnapshot(project, { version: 1, values: { review: { target: "API" } },
        skills: [{ id: "review", name: "Review", description: "Original catalog", category: "code", icon: "*", accentColor: "#fff",
          template: "FROZEN {{target}}", variables: [], subskills: [{ id: "rules", name: "Rules", description: "Use for review", body: "LAZY" }] }] });
      writeSkills(project, []);
      const prompt = getAgentType("leader").buildSystemPrompt({ sessionKey: "frozen-leader", cwd: project,
        bus: createBus({ clients: new Set() } as unknown as WebSocketServer), worktreeInfo: null, worktreeIsolation: false,
        skillIds: ["review"], skillSnapshotId }, encodeLeaderPromptCustomization({ skillsAddendum: "STALE_CLIENT_BODY" }));
      expect(prompt).toContain("FROZEN API");
      expect(prompt).toContain("Original catalog");
      expect(prompt).toContain("load_subskill");
      expect(prompt).not.toContain("STALE_CLIENT_BODY");
      expect(prompt).not.toContain("LAZY");
    } finally { fs.rmSync(project, { recursive: true, force: true }); }
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
      "leader-procedures",
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

  it("adds role guidance to new Leaders and Minions only when the beta setting is enabled", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "leader-role-test-"));
    try {
      const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
      const leader = getAgentType("leader");
      const baseCtx = {
        sessionKey: "leader-role",
        cwd: project,
        bus,
        worktreeInfo: null,
        worktreeIsolation: false,
      };

      writeSettings(project, { roleSystemBeta: false });
      expect(leader.buildSystemPrompt(baseCtx)).not.toContain("Role System (Beta)");

      writeSettings(project, { roleSystemBeta: true });
      const leaderPrompt = leader.buildSystemPrompt(baseCtx);
      expect(leaderPrompt).toMatch(/roles as compact task operating contracts/i);
      expect(leaderPrompt).toMatch(/role-aware Minions infer/i);

      const startMinionSession = vi.fn();
      const result = leader.getToolGroups({
        ...baseCtx,
        startMinionSession,
        scheduleWaitContinue: vi.fn(),
      });
      const assignTask = result.toolGroups["task-manager"]!.find(
        (tool) => tool.name === "assign_task",
      );
      await assignTask!.handler({
        taskId: "role-task",
        title: "Role task",
        description: "Implement the focused change.",
        priority: "medium",
      });

      expect(startMinionSession).toHaveBeenCalledWith(expect.objectContaining({
        systemPrompt: expect.stringContaining(ROLE_SYSTEM_PROMPT),
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
      "leader-procedures",
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
      "record_work_packet_evidence",
      "reconcile_run",
      "record_constraint_verdicts",
      "model_health",
    ]);
    expect(result.mcpToolNames).toContain("mcp__system-model__query_system_model");
    expect(result.mcpToolNames).toContain("mcp__system-model__create_work_packet");
  });

  it("wires an actual-diff provider into reconcile_run", async () => {
    const project = copyValidFixture();
    const git=promisify(execFile);
    await git("git", ["init", "-q"], {cwd:project});
    await git("git", ["add", "."], {cwd:project});
    await git("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture"], {cwd:project});
    writeSettings(project, { systemModel: "advisory" });
    const result = getAgentType("leader").getToolGroups({
      sessionKey: "leader-reconcile",
      cwd: project,
      bus: createBus({ clients: new Set() } as unknown as WebSocketServer),
      worktreeInfo: null,
      worktreeIsolation: false,
      startMinionSession: vi.fn(),
      scheduleWaitContinue: vi.fn(),
    });
    const createPacket = result.toolGroups["system-model"]!
      .find((tool) => tool.name === "create_work_packet")!;
    const created = await createPacket.handler({
      userRequest: "approve workspace change",
      objectIds: ["capability.workspace_management"],
    });
    const packetId = JSON.parse(created.content[0]!.text).packet.id as string;
    const reconcile = result.toolGroups["system-model"]!
      .find((tool) => tool.name === "reconcile_run")!;

    const reconciled = await reconcile.handler({
      workPacketId: packetId,
      agentSummary: "No repository changes in fixture.",
    });
    const payload = JSON.parse(reconciled.content[0]!.text) as {
      report: { deterministic: { changedFiles: string[] } };
      error?: string;
    };

    expect(payload.error).toBeUndefined();
    expect(payload.report.deterministic.changedFiles).toEqual([]);
  });

  it.each(["advisory", "enforced"] as const)("discloses optional retrieval and conditional requirements in %s mode", (mode) => {
    const project = copyValidFixture();
    writeSettings(project, { systemModel: mode });
    for (const orchestrationMode of ["direct", "auto"] as const) {
      const prompt = getAgentType("leader").buildSystemPrompt({
        sessionKey: "leader-retrieval", cwd: project,
        bus: createBus({ clients: new Set() } as unknown as WebSocketServer),
        worktreeInfo: null, worktreeIsolation: false, orchestrationMode,
      });
      const addendum = prompt!.slice(prompt!.indexOf("## System Model"));
      expect(addendum).toContain("search compact cards");
      expect(addendum).toContain("read selected ids with facets");
      expect(addendum).toContain("expand chosen relationships");
      expect(addendum).toContain("without another confirmation");
      expect(addendum).toContain("For an existing packet");
      expect(addendum).toContain("no_change_needed");
      expect(addendum).not.toContain("Gated surfaces");
      expect(addendum).not.toContain("server/**/*.ts");
      expect(addendum).toContain(mode === "enforced" ? "Enforced runtime checks require" : "Advisory runtime checks report");
      expect(addendum.length).toBeLessThan(1600);
    }
  });

  it.each([1, 5, 20, 40])("preserves mandatory procedure under a tiny %i-token optional context budget", (budget) => {
    const project = copyValidFixture();
    writeSettings(project, { systemModel: "advisory" });
    fs.writeFileSync(path.join(project, ".systemmodel/policies/context-budgets.yaml"),
      `leaderPromptAddendum: ${budget}\nminionContextPack: 2000\nperObjectSummary: 250\n`);
    const ctx = { sessionKey: "leader-small-budget", cwd: project,
      bus: createBus({ clients: new Set() } as unknown as WebSocketServer),
      worktreeInfo: null, worktreeIsolation: false };
    const enabled = getAgentType("leader").buildSystemPrompt(ctx);
    writeSettings(project, { systemModel: "off" });
    const disabled = getAgentType("leader").buildSystemPrompt(ctx);
    expect(enabled).not.toContain("fetch omitted objects");
    // Mandatory procedure has a reserved floor; omit optional discovery first.
    const marker = enabled!.lastIndexOf("## System Model");
    const addendum = enabled!.slice(marker);
    expect(marker).toBeGreaterThan(0);
    expect(addendum.length).toBeLessThan(800);
    for (const instruction of ["create_work_packet", "workPacketId", "record_work_packet_evidence",
      "reconcile_run", "constraint verdicts", "no_change_needed", "omitted by context budget"]) {
      expect(addendum).toContain(instruction);
    }
    expect(disabled).not.toContain("## System Model");
  });

  // Per-turn completion must not sweep children; leaders can pause while
  // minions continue running. Only explicit termination owns that teardown.
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
