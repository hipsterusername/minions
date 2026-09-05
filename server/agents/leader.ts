import { readSkillSnapshot, selectSnapshotSkills } from "../skill-snapshot.ts";
import { createLeaderProcedureTools } from "../leader-procedure-tools.ts";
import { LEADER_PROCEDURE_TOOL_NAMES } from "../../shared/leader-procedures.ts";
/**
 * Leader agent type — orchestrator that decomposes work and delegates
 * via MCP task-management tools.
 */

import { registerAgentType } from "./registry.ts";
import type { AgentType, AgentTypeContext, AgentToolResult } from "./types.ts";
import { createTaskToolsForLeader } from "../task-tools.ts";
import { createTaskGraphPlanningTools } from "../task-graph/planning-tools.ts";
import { createRenderToolsForLeader } from "../render-tools.ts";
import { createSystemModelToolsForLeader } from "../system-model-tools/index.ts";
import { createSkillAuthoringTools } from "../skill-authoring-tools.ts";
import { resolveSystemModelRuntime, type SystemModelRuntime } from "../system-model/runtime.ts";
import { MINION_SYSTEM_PROMPT } from "./minion.ts";
import { readSettings } from "../project-store.ts";
import { createLeaderStateCallbacks } from "./leader-state-callbacks.ts";
import type { SessionTerminateReason } from "../session-host-terminate.ts";
import { cancelChildrenOnLeaderTeardown } from "./leader-teardown.ts";
import {
  CLAUDE_LEADER_BUILT_IN_TOOLS,
  TASK_GRAPH_LEADER_TOOL_NAMES,
  buildLeaderSkillInventory,
  composeLeaderPrompt,
  decodeLeaderPromptCustomization,
} from "../../shared/leader-prompt.ts";
import {
  LEADER_RENDER_TOOL_NAMES,
} from "../../shared/leader-planning.ts";
import {
  resolveLeaderPlanningProfile,
  type LeaderPlanningProfile,
} from "./leader-planning-profile.ts";
import {
  LEADER_ROLE_SYSTEM_PROMPT,
  appendRoleSystemPrompt,
} from "../../shared/prompts/role-system.ts";
import {
  compileSkills,
  loadAllSkills,
  loadSkillsByIds,
} from "../skills.ts";
import { getDetailedDiff } from "../worktree.ts";

function buildSystemModelAddendum(runtime: SystemModelRuntime, graphMode = false): string {
  if (runtime.mode === "off" || !runtime.model) return "";
  const discovery = `## System Model

Use \`query_system_model\` when architecture context would help: search compact cards by question or files, read selected ids with facets, and expand chosen relationships. Reading asserts relevance without another confirmation. Omitted facets return previews; follow page.nextCursor with the same arguments for more. Model snapshots are guidance; inspect current code and use \`check_freshness\` when needed.`;
  const workflow = graphMode
    ? "Graph steps declare affected files and associated Work Packet IDs; direct plan_task/assign_task remain available."
    : "plan_task and assign_task report packet requirements for declared files.";
  const requirements = runtime.mode === "enforced"
    ? "Enforced runtime checks require a valid packet for gated assignments."
    : "Advisory runtime checks report applicable packet guidance.";
  const application = `Discovery does not create a Work Packet. ${workflow} ${requirements} Use \`create_work_packet\` for scoped work and pass workPacketId when assigning it. For an existing packet, record evidence and coverage, reconcile the stable actual diff, resolve constraint verdicts, and validate a model update or record an evidence-backed no_change_needed assessment before closure.`;
  const maxChars = runtime.model.policies.contextBudgets.leaderPromptAddendum * 4;
  const full = `${discovery}\n\n${application}`;
  if (full.length <= maxChars) return full;
  // The configured budget controls optional context, not mandatory workflow.
  // Reserve a complete compact procedure even when that budget is too small.
  return "## System Model\n\n[Optional discovery detail omitted by context budget; mandatory procedure retained.]\n\n"
    + "Use query_system_model for guidance and inspect current code. Runtime packet checks apply: create_work_packet for gated work; pass workPacketId with scoped files. Record evidence and coverage with record_work_packet_evidence. After a stable diff, reconcile_run, resolve constraint verdicts, and validate a model update or record evidence-backed no_change_needed before closure. Use load_procedure {id: reconciliation} for details when available.";
}

const SKILL_AUTHORING_TOOL_NAMES = [
  "list_skills", "get_skill", "create_skill", "update_skill", "delete_skill",
];
const SYSTEM_MODEL_TOOL_NAMES = [
  "query_system_model", "create_work_packet", "amend_work_packet",
  "check_freshness", "record_verification", "record_work_packet_evidence", "reconcile_run",
  "record_constraint_verdicts", "model_health",
];
/** The skill ID that gates the skill-authoring tools. */
const SKILL_BUILDER_ID = "skill-builder";

function registeredPromptToolNames(
  ctx: AgentTypeContext,
  runtime: SystemModelRuntime,
  planning: LeaderPlanningProfile,
): string[] {
  return [
    ...LEADER_PROCEDURE_TOOL_NAMES,
    ...planning.taskToolNames,
    ...planning.planningToolNames,
    ...(ctx.worktreeIsolation && ctx.worktreeInfo ? ["request_approval"] : []),
    ...LEADER_RENDER_TOOL_NAMES,
    ...(ctx.skillIds?.includes(SKILL_BUILDER_ID) ? SKILL_AUTHORING_TOOL_NAMES : []),
    ...(runtime.mode !== "off" && runtime.model ? SYSTEM_MODEL_TOOL_NAMES : []),
  ];
}

function buildSkillsAddendum(
  ctx: AgentTypeContext,
  frozenSkillsAddendum: string,
  planning: LeaderPlanningProfile,
): string {
  const projectPath = ctx.worktreeInfo?.projectPath ?? ctx.cwd;
  const snapshot = ctx.skillSnapshotId ? readSkillSnapshot(projectPath, ctx.skillSnapshotId) : null;
  const allSkills = snapshot?.skills ?? loadAllSkills(projectPath);
  const active = snapshot ? compileSkills(selectSnapshotSkills(snapshot, ctx.skillIds ?? []), snapshot.values) : frozenSkillsAddendum || compileSkills(
    loadSkillsByIds(projectPath, ctx.skillIds ?? []),
    ctx.skillValues ?? {},
  );
  const inventory = planning.includeSkillInventory
    ? buildLeaderSkillInventory(allSkills) : "";
  return [active, inventory].filter(Boolean).join("\n\n");
}

function isRoleSystemEnabled(ctx: AgentTypeContext): boolean {
  const projectPath = ctx.worktreeInfo?.projectPath ?? ctx.cwd;
  return readSettings(projectPath).roleSystemBeta === true;
}

/**
 * Default server preview for tests and server callers without session context.
 * Runtime assembly below remains authoritative.
 */
export const LEADER_SYSTEM_PROMPT = composeLeaderPrompt({
  builtInTools: CLAUDE_LEADER_BUILT_IN_TOOLS,
  registeredToolNames: TASK_GRAPH_LEADER_TOOL_NAMES,
});

const leaderAgent: AgentType = {
  id: "leader",

  buildSystemPrompt(ctx: AgentTypeContext, customPrompt?: string, tools?: string[]): string {
    const systemModelRuntime = resolveSystemModelRuntime(ctx);
    const roleSystemEnabled = isRoleSystemEnabled(ctx);
    const customization = decodeLeaderPromptCustomization(customPrompt);
    const planning = resolveLeaderPlanningProfile({
      orchestrationMode: ctx.orchestrationMode,
      hasCanonicalIdentity: Boolean(ctx.workItemId && ctx.runKey),
    });
    return composeLeaderPrompt({
      builtInTools: (tools ?? CLAUDE_LEADER_BUILT_IN_TOOLS)
        .filter(name => !ctx.effectiveCapabilities || ctx.effectiveCapabilities.allowedTools.includes(name)),
      registeredToolNames: ctx.effectiveCapabilities
        ? ctx.effectiveCapabilities.allowedTools.filter(name => name.startsWith("mcp__"))
        : registeredPromptToolNames(ctx, systemModelRuntime, planning),
      ...(ctx.effectiveCapabilities ? {
        nativeFilesystem: ctx.effectiveCapabilities.nativeFilesystem,
        filesystemScope: ctx.effectiveCapabilities.filesystemScope,
        approvalPolicy: ctx.effectiveCapabilities.approvalPolicy,
      } : {}),
      promptFeatureIds: planning.promptFeatureIds,
      roleSystemAddendum: roleSystemEnabled ? LEADER_ROLE_SYSTEM_PROMPT : "",
      skillsAddendum: buildSkillsAddendum(ctx, customization.skillsAddendum, planning),
      // For Leaders only, the WS `systemPrompt` slot is a structured
      // prefix + frozen-skill envelope. It can customize designated sections
      // but never replace the canonical core or capability inventory.
      userPrefix: customization.promptPrefix,
      systemModelAddendum: buildSystemModelAddendum(
        systemModelRuntime,
        planning.usesTaskGraph,
      ),
    });
  },

  getToolGroups(ctx: AgentTypeContext): AgentToolResult {
    if (!ctx.startMinionSession || !ctx.scheduleWaitContinue) {
      throw new Error("Leader agent requires startMinionSession and scheduleWaitContinue callbacks");
    }

    const leaderSessionKey = ctx.sessionKey;

    // Resolved once up front: task tools need it for the packet trigger (§5).
    const systemModelRuntime = resolveSystemModelRuntime(ctx);
    const roleSystemEnabled = isRoleSystemEnabled(ctx);
    const planning = resolveLeaderPlanningProfile({
      orchestrationMode: ctx.orchestrationMode,
      hasCanonicalIdentity: Boolean(ctx.workItemId && ctx.runKey),
    });
    if (planning.usesTaskGraph && (!ctx.taskGraphPlanning
      || !ctx.workItemId || !ctx.runKey)) {
      throw new Error("Graph-mode Leader requires canonical planning authority");
    }

    const lifecycleCallbacks = createLeaderStateCallbacks(ctx, leaderSessionKey);
    const { toolDefs: taskDefs, taskState } = createTaskToolsForLeader({
      leaderSessionKey,
      bus: ctx.bus,
      startMinionSession: ctx.startMinionSession,
      cwd: ctx.cwd,
      // Skills live in the sidecar of the original project, not the worktree.
      projectPath: ctx.worktreeInfo?.projectPath ?? ctx.cwd,
      minionSystemPrompt: appendRoleSystemPrompt(
        MINION_SYSTEM_PROMPT,
        roleSystemEnabled,
      ),
      skillSnapshotId: ctx.skillSnapshotId,
      defaultMinionSkillIds: ctx.skillIds ?? [],
      defaultMinionSkillValues: ctx.skillValues ?? {},
      systemModel: systemModelRuntime.mode !== "off" ? systemModelRuntime.model : null,
      existingTaskState: ctx.existingTaskState,
      getSessionRuntime: ctx.getSessionRuntime,
      worktreeBranch: ctx.worktreeInfo?.branch ?? null,
      worktreeInfo: ctx.worktreeInfo ?? null,
      worktreeIsolation: ctx.worktreeIsolation,
      scheduleWaitContinue: ctx.scheduleWaitContinue,
      terminateSession: ctx.terminateSession,
      messageSession: ctx.messageSession,
      // Persist every task-state mutation so the plan survives a server restart.
      onStateChange: lifecycleCallbacks.onTaskStateChange,
      onTaskNameChange: ctx.updateTaskName,
      getRenderComponents: ctx.getRenderComponents,
      planningBackend: planning.backend,
    });

    const planningDefs = planning.usesTaskGraph
      ? createTaskGraphPlanningTools({
        coordinator: ctx.taskGraphPlanning!,
        workItemId: ctx.workItemId!,
        primaryRunKey: ctx.runKey!,
        mode: planning.orchestrationMode === "plan" ? "plan" : "auto",
        leaderSessionKey,
        markDecisionNeeded: ctx.markDecisionNeeded,
      }) : [];

    const { toolDefs: renderDefs, renderState } = createRenderToolsForLeader({
      leaderSessionKey,
      bus: ctx.bus,
      existingRenderState: ctx.existingRenderState,
      onStateChange: lifecycleCallbacks.onRenderStateChange,
    });

    const systemModelDefs = systemModelRuntime.mode !== "off" && systemModelRuntime.model
      ? createSystemModelToolsForLeader({
        leaderSessionKey,
        projectPath: ctx.worktreeInfo?.projectPath ?? ctx.cwd,
        cwd: ctx.cwd,
        runtime: systemModelRuntime,
        bus: ctx.bus,
        getDetailedDiff: () => getDetailedDiff(ctx.worktreeInfo ?? {
          path: ctx.cwd,
          branch: "HEAD",
          leaderSessionKey,
          createdAt: 0,
          projectPath: ctx.cwd,
          lifecycle: "active",
        }),
      })
      : [];

    // Skill authoring is opt-in: load the tools only when this leader session
    // tagged the `skill-builder` skill. Reads/writes the sidecar of the
    // original project, not the worktree — same projectPath resolution as the
    // task tools above.
    const hasSkillBuilder = ctx.skillIds?.includes(SKILL_BUILDER_ID) ?? false;
    const skillAuthoringDefs = hasSkillBuilder
      ? createSkillAuthoringTools({
        projectPath: ctx.worktreeInfo?.projectPath ?? ctx.cwd,
      })
      : [];

    const toolGroups: Record<string, import("../harness/types.ts").NormalizedToolDef[]> = {
      "leader-procedures": createLeaderProcedureTools(),
      "task-manager": taskDefs,
      ...(planningDefs.length > 0 ? { "graph-planner": planningDefs } : {}),
      "render-dashboard": renderDefs,
      ...(hasSkillBuilder ? { skills: skillAuthoringDefs } : {}),
      ...(systemModelDefs.length > 0 ? { "system-model": systemModelDefs } : {}),
    };

    return {
      toolGroups,
      mcpToolNames: Object.entries(toolGroups).flatMap(([group, defs]) =>
        defs.map((def) => `mcp__${group}__${def.name}`)
      ),
      taskState,
      renderState,
    };
  },

  wantsWorktree: true,
  detectsSubagents: true,

  // Child cleanup belongs to session teardown, never per-run completion.
  onTerminate(ctx: AgentTypeContext, reason: SessionTerminateReason): void {
    cancelChildrenOnLeaderTeardown(ctx, reason);
  },
};

registerAgentType(leaderAgent);
