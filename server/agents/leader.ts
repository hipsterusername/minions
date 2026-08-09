/**
 * Leader agent type — orchestrator that decomposes work and delegates
 * via MCP task-management tools.
 */

import { registerAgentType } from "./registry.ts";
import type { AgentType, AgentTypeContext, AgentToolResult } from "./types.ts";
import { createTaskToolsForLeader } from "../task-tools.ts";
import { createRenderToolsForLeader } from "../render-tools.ts";
import { createSystemModelToolsForLeader } from "../system-model-tools/index.ts";
import { createSkillAuthoringTools } from "../skill-authoring-tools.ts";
import { resolveSystemModelRuntime, type SystemModelRuntime } from "../system-model/runtime.ts";
import { gatedSurfaceGlobs } from "../system-model/applicability.ts";
import { MINION_SYSTEM_PROMPT } from "./minion.ts";
import { readSettings } from "../project-store.ts";
import { createLeaderStateCallbacks } from "./leader-state-callbacks.ts";
import type { SessionTerminateReason } from "../session-host-terminate.ts";
import { cancelChildrenOnLeaderTeardown } from "./leader-teardown.ts";
import {
  CLAUDE_LEADER_BUILT_IN_TOOLS,
  DEFAULT_LEADER_TOOL_NAMES,
  buildLeaderSkillInventory,
  composeLeaderPrompt,
  decodeLeaderPromptCustomization,
} from "../../shared/leader-prompt.ts";
import {
  LEADER_ROLE_SYSTEM_PROMPT,
  appendRoleSystemPrompt,
} from "../../shared/prompts/role-system.ts";
import {
  compileSkills,
  loadAllSkills,
  loadSkillsByIds,
} from "../skills.ts";

// ── System prompt ─────────────────────────────────────────────────────────

const SYSTEM_MODEL_TRUNCATION_POINTER =
  "[system-model addendum truncated — use `query_system_model` to fetch omitted objects]";

function buildSystemModelAddendum(runtime: SystemModelRuntime): string {
  if (runtime.mode === "off" || !runtime.model) return "";
  // Redesign §6: factual addendum listing gated surfaces, no "query for planning" mandate.
  const globs = gatedSurfaceGlobs(runtime.model);
  const surfaces = globs.length > 0 ? globs.join(", ") : "(none currently defined)";
  const addendum = `## System Model

A system model is active. Gated surfaces — a work packet is required when a task touches them: ${surfaces}. You do not need to check preemptively: \`plan_task\` and \`assign_task\` compute this deterministically and tell you when a task hits one. When assigning a minion for packet-scoped work, pass \`workPacketId\` to \`assign_task\` so the stored Context Pack is injected.

Tools (available, not mandated): \`query_system_model\` (scored, topK), \`create_work_packet\`, \`amend_work_packet\`, \`check_freshness\`, \`record_verification\`.`;
  const maxChars = runtime.model.policies.contextBudgets.leaderPromptAddendum * 4;
  if (addendum.length <= maxChars) return addendum;
  const bodyChars = Math.max(0, maxChars - SYSTEM_MODEL_TRUNCATION_POINTER.length - 1);
  return `${addendum.slice(0, bodyChars)}\n${SYSTEM_MODEL_TRUNCATION_POINTER}`;
}

const SKILL_AUTHORING_TOOL_NAMES = [
  "list_skills", "get_skill", "create_skill", "update_skill", "delete_skill",
];
const SYSTEM_MODEL_TOOL_NAMES = [
  "query_system_model", "create_work_packet", "amend_work_packet",
  "check_freshness", "record_verification", "reconcile_run",
  "record_constraint_verdicts", "model_health",
];

/** The skill ID that gates the skill-authoring tools. */
const SKILL_BUILDER_ID = "skill-builder";

function registeredPromptToolNames(
  ctx: AgentTypeContext,
  runtime: SystemModelRuntime,
): string[] {
  return [
    ...DEFAULT_LEADER_TOOL_NAMES,
    ...(ctx.worktreeIsolation && ctx.worktreeInfo ? ["request_approval"] : []),
    ...(ctx.skillIds?.includes(SKILL_BUILDER_ID) ? SKILL_AUTHORING_TOOL_NAMES : []),
    ...(runtime.mode !== "off" && runtime.model ? SYSTEM_MODEL_TOOL_NAMES : []),
  ];
}

function buildSkillsAddendum(
  ctx: AgentTypeContext,
  frozenSkillsAddendum: string,
): string {
  const projectPath = ctx.worktreeInfo?.projectPath ?? ctx.cwd;
  const allSkills = loadAllSkills(projectPath);
  const active = frozenSkillsAddendum || compileSkills(
    loadSkillsByIds(projectPath, ctx.skillIds ?? []),
    ctx.skillValues ?? {},
  );
  const inventory = buildLeaderSkillInventory(allSkills);
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
  registeredToolNames: DEFAULT_LEADER_TOOL_NAMES,
});

// ── AgentType implementation ──────────────────────────────────────────────

const leaderAgent: AgentType = {
  id: "leader",

  buildSystemPrompt(ctx: AgentTypeContext, customPrompt?: string, tools?: string[]): string {
    const systemModelRuntime = resolveSystemModelRuntime(ctx);
    const roleSystemEnabled = isRoleSystemEnabled(ctx);
    const customization = decodeLeaderPromptCustomization(customPrompt);
    return composeLeaderPrompt({
      builtInTools: tools ?? CLAUDE_LEADER_BUILT_IN_TOOLS,
      registeredToolNames: registeredPromptToolNames(ctx, systemModelRuntime),
      roleSystemAddendum: roleSystemEnabled ? LEADER_ROLE_SYSTEM_PROMPT : "",
      skillsAddendum: buildSkillsAddendum(ctx, customization.skillsAddendum),
      // For Leaders only, the WS `systemPrompt` slot is a structured
      // prefix + frozen-skill envelope. It can customize designated sections
      // but never replace the canonical core or capability inventory.
      userPrefix: customization.promptPrefix,
      systemModelAddendum: buildSystemModelAddendum(systemModelRuntime),
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
    });

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
      "task-manager": taskDefs,
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

  // Child cleanup on close/remove ONLY — never on run completion. See
  // leader-teardown.ts for the rationale and leader.test.ts for the
  // regression tests.
  onTerminate(ctx: AgentTypeContext, reason: SessionTerminateReason): void {
    cancelChildrenOnLeaderTeardown(ctx, reason);
  },
};

registerAgentType(leaderAgent);
