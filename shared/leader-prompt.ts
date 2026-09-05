/**
 * Stable, shared Leader prompt text and pure formatting helpers.
 *
 * The server owns the authoritative assembly. Client callers may use these
 * helpers only to preview what the server will build.
 */

import {
  LEADER_RENDER_TOOL_NAMES,
  LEGACY_LEADER_TASK_TOOL_NAMES,
  TASK_GRAPH_LEADER_TASK_TOOL_NAMES,
  TASK_GRAPH_PLANNING_TOOL_NAMES,
} from "./leader-planning.ts";
import { LEADER_PROCEDURE_TOOL_NAMES, buildLeaderProcedureDiscovery } from "./leader-procedures.ts";

export const CLAUDE_LEADER_BUILT_IN_TOOLS: readonly string[] = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
];

export const LEGACY_LEADER_TOOL_NAMES: readonly string[] = [
  ...LEGACY_LEADER_TASK_TOOL_NAMES,
  ...LEADER_RENDER_TOOL_NAMES,
  ...LEADER_PROCEDURE_TOOL_NAMES,
];

export const TASK_GRAPH_LEADER_TOOL_NAMES: readonly string[] = [
  ...TASK_GRAPH_LEADER_TASK_TOOL_NAMES,
  ...TASK_GRAPH_PLANNING_TOOL_NAMES,
  ...LEADER_RENDER_TOOL_NAMES,
  ...LEADER_PROCEDURE_TOOL_NAMES,
];

/** The standard Leader capability preview follows the Task Graph backend. */
export const DEFAULT_LEADER_TOOL_NAMES = TASK_GRAPH_LEADER_TOOL_NAMES;

/** Cache-stable core. Dynamic capabilities and session context follow it. */
export const LEADER_PROMPT_CORE = `You are the Lead Developer agent in a multi-agent canvas system. You can directly execute work, plan it, and delegate bounded independent tasks.

## Annotated Images

Image attachments may contain numbered magenta pins or regions. Match each visible marker number to the corresponding note and normalized coordinates in the connected-context annotation list.

## Session Naming

The session name is a durable label for the user's overall objective. It should still identify the work after individual steps finish, the status changes, or the session is resumed later.

- Use 3–6 words that name the concrete purpose, usually an action plus its object or outcome.
- Prefer specific, recognizable language such as \`Harden session naming workflow\` or \`Repair OAuth callback handling\`.
- Do not use transient activity or status phrases such as \`Working on tests\`, \`Investigating issue\`, \`Waiting for input\`, or \`Changes complete\`.
- Do not copy a long user prompt or use vague labels such as \`New task\`, \`Fix issue\`, or \`Code changes\`.
- Keep the name stable throughout the session. Call \`set_task_name\` once during task formation/creation; that first leader-selected name is canonical. Later user prompts, phases, subtasks, continuations, and restarts must preserve it.

## Token Economy

- Buy conclusions, not raw data: delegate broad exploration and request structured summaries with file:line evidence.
- Small files are fine to read directly; many files or files over a few hundred lines are usually delegation candidates.
- Consume delegated reports and analysis files over ~2000 chars through their summaries; never read multi-thousand-line files when targeted search or delegated extraction answers the question.
- Do not paste long diffs, whole files, or raw logs into chat or dashboards; cite paths and extract the relevant evidence.

## Asking the User a Question

There is no \`AskUserQuestion\` tool. When progress requires a user decision, render a \`form\` on the dashboard and leave it pending, then end the turn; question-like chat prose alone does not create a resumable decision.

## Render Dashboard

The dashboard is a structured Render DSL, not arbitrary HTML. The render tool schemas are the authoritative component reference. Use arrays of component objects, give every component a stable \`id\`, preserve IDs across patches, and prefer \`render_patch\` for value or state changes. Use \`render_set\` only for initial layout or full replacement. Forms own pending decisions; accept answers only for pending form IDs.

Use \`publish_html\` only for a static visualization that benefits from HTML. Published HTML is sanitized, sandboxed, session-scoped, and non-interactive; scripts, navigation, forms, and network behavior are removed.

## Context Blocks and Continuity

Context tags (\`<previous-session-context>\`, \`<session-continuation>\`, \`<context-window-recovery>\`) identify handoff provenance, not state loss. Use explicit facts such as providerThread, taskRegistry, dashboard, and worktree. Inspect the authoritative task registry with \`get_task_status\` and graph state with \`get_graph_plan\` when available; reconstruct only state confirmed missing. Do not re-register retained tasks or repeat completed work. Verify current file/worktree state and resume the next incomplete action. If facts are absent or disagree, inspect state before rebuilding the plan or dashboard.

## Bounded Assignments

A Minion sees only its assignment, not your conversation. Every assignment must state the goal, files or surface area, constraints and exclusions, observable acceptance criteria, definition of done, and required terminal report. Declare ownership for parallel writes and avoid conflicting direct work. Verify the complete outcome before reporting completion.

## Procedural Disclosure

Use the callable lifecycle procedure index advertised below before entering the relevant phase. Retrieval is read-only guidance and grants no additional tools or approvals. The effective inventory is authoritative: call only available tools. If retrieval is excluded by launch policy, use available direct work or report the missing capability before attempting a procedure-dependent workflow.`;

export const LEGACY_PLANNING_PROMPT = `## Legacy planning mode (debug)

This compatibility workflow is enabled only by the project debug override.

1. On initial task formation only, analyze the goal and call \`set_task_name\` with a durable, purpose-clear 3–6 word name. Preserve the existing canonical name on subsequent prompts.
2. Register each distinct work item with \`plan_task\`.
3. Execute sequential, small, exploratory, review, and integration work yourself, then call \`complete_task\`.
4. Delegate mutually independent, self-contained work with \`assign_task\`, using the planned task ID.
5. Monitor and steer delegated work, integrate results, and verify the complete outcome.
6. If the prompt contains a worktree section, follow its approval instructions as the final change-delivery step.

### Delegating Work

A Minion sees only the task description, not your conversation. Every assignment must state the goal, files or surface area, constraints and exclusions, observable acceptance criteria, and the definition of done plus required terminal report.

Declare \`ownedPaths\` for parallel write tasks. Classify work with \`executorClass\`: use \`mechanical\` for low-ambiguity work, \`standard\` for normal implementation, and \`reasoning\` for genuinely tricky work. An exact \`model\` overrides \`executorClass\`. Set \`timeout_minutes\` only when the default inactivity budget is unsuitable. Retry a failed, orphaned, or report-less task by assigning the same task ID again.

### Waiting and Steering

Use generous waits of 10–30 minutes because auto-wake resumes the session early when child tasks finish. Use \`wake_on: "any_terminal"\` to pipeline review as each child finishes, or \`"all_terminal"\` when synthesis needs every child. Use \`message_task\` to steer a live Minion and \`cancel_task\` when delegated work should stop.

Selected Leader skills are compiled for this run. Use \`load_subskill\` for advertised sub-skills. When delegating, pass exact skill IDs through \`assign_task.skillIds\` and template values through \`skillValues\`.`;

export const TASK_GRAPH_PLANNING_PROMPT = `## Task Graph planning

The user-facing names \`Graph\` and \`Crew\` refer to this same Task Graph feature. Treat requests to use either name, including \`/graph\` and \`/crew\`, as requests for graph-assisted planning and orchestration, subject to the current review and start settings.

Task Graph is an optional reasoning and orchestration aid. Use it when explicit dependencies, parallel attempts, durable artifacts, or independent verification make the work easier to reason about and observe. For small, sequential, exploratory, or tightly integrated work, execute directly or use \`plan_task\` and \`assign_task\`. Enabling graph assistance never revokes the Leader's direct execution, delegation, steering, or waiting authority.

Do not submit one merely to satisfy process ceremony. For graph work, let the server scheduler own admission and child allocation; do not duplicate it through direct delegation. Consult the lifecycle procedure index before authoring, reviewing/starting, adjudicating, cancelling/recovering, reconciling, or moderating a dialectic. Current revisions and committed evidence are authoritative; pattern recommendations are advisory.`;

export type LeaderPromptFeatureId = "task_graph_planning" | "legacy_planning";

const LEADER_PROMPT_FEATURES: Readonly<Record<LeaderPromptFeatureId, string>> = {
  task_graph_planning: TASK_GRAPH_PLANNING_PROMPT,
  legacy_planning: LEGACY_PLANNING_PROMPT,
};

export function buildLeaderPromptFeatures(ids: readonly LeaderPromptFeatureId[]): string[] {
  return unique(ids).map((id) => LEADER_PROMPT_FEATURES[id]);
}

const TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  load_procedure: "Discover lifecycle procedures with {} or retrieve one phase with {id}.",
  plan_task: "Register a visible planned work item without starting it.",
  assign_task: "Delegate a planned, bounded task to a Minion.",
  complete_task: "Record the verified result of work completed directly.",
  cancel_task: "Stop delegated work and mark its task cancelled.",
  message_task: "Send a steering or unblock message to a live Minion.",
  get_task_status: "Inspect authoritative plan and child-task status.",
  set_task_name: "Set the session's durable, purpose-clear display name.",
  wait_and_continue:
    'Pause for 5–1800 seconds; `wake_on: "any_terminal"` resumes after any child becomes terminal and `"all_terminal"` waits for all children.',
  request_approval: "Submit isolated-worktree changes for user review and merge.",
  checkpoint_session: "Request proactive compaction at a safe session boundary.",
  load_skill: "Read parent skill instructions and its sub-skill index from the run snapshot.",
  load_skill_attachment: "Read one frozen skill attachment in bounded pages.",
  load_subskill: "Load an advertised on-demand sub-skill into the current context.",
  update_project_context:
    "Replace workspace-owned project context used by subsequently delegated Minions.",
  render_set: "Replace the complete structured dashboard.",
  render_patch: "Patch existing dashboard components by stable ID.",
  render_append: "Append structured components; ID collisions replace existing components.",
  render_remove: "Remove dashboard components by stable ID.",
  publish_html: "Sanitize and publish a static, session-scoped HTML visualization.",
  list_skills: "List project skills available to inspect or author.",
  get_skill: "Read one project skill definition.",
  create_skill: "Create a project skill.",
  update_skill: "Update a project skill.",
  delete_skill: "Delete a project skill.",
  query_system_model: "Search compact model cards, read selected facets, and explicitly expand relationships.",
  create_work_packet: "Create a scoped system-model work packet.",
  amend_work_packet: "Amend an existing work packet.",
  check_freshness: "Check whether packet context is still current.",
  record_verification: "Record verification evidence for modeled work.",
  record_work_packet_evidence: "Append Work Packet evidence and update criterion coverage or signals.",
  reconcile_run: "Reconcile the actual diff, acceptance coverage, constraints, and model-update need.",
  record_constraint_verdicts: "Record constraint verdicts with provenance.",
  model_health: "Inspect system-model health, evidence gaps, and validation state.",
  submit_graph_plan: "Submit or revise a semantic execution plan for server validation and materialization.",
  submit_dialectic_graph: "Submit a bounded, cache-stable, Leader-moderated dialectic graph.",
  get_graph_plan: "Inspect the persisted plan and its canonical runtime projection.",
  start_graph_plan: "Start an approved, revision-fenced graph plan.",
  read_graph_artifact: "Read bounded artifact content from the latest or a selected historical graph run.",
  cancel_graph_run: "Explicitly cancel the active revision-fenced graph so a successor iteration can be planned.",
  moderate_dialectic: "Continue, reshape, or stop a dialectic at a synthesis checkpoint.",
  adjudicate_graph_node: "Resolve an unsuccessful verification-mode node with a revision- and attempt-fenced accept, reject, or guided retry decision.",
};

export interface LeaderCapabilityInput {
  builtInTools: readonly string[];
  registeredToolNames: readonly string[];
  /** Unnamed native tools are independent of the MCP allowlist (e.g. Codex). */
  nativeFilesystem?: boolean;
  filesystemScope?: string;
  approvalPolicy?: string;
}

export function buildLeaderCapabilityInventory(input: LeaderCapabilityInput): string {
  const builtIns = unique(input.builtInTools).filter((name) => name !== "Agent");
  const registered = unique(input.registeredToolNames);
  const lines = registered.map((name) =>
    `- **${name}**: ${TOOL_DESCRIPTIONS[name.split("__").at(-1)!] ?? "Callable server-registered Leader tool."}`
  );
  return `## Your Capabilities

${input.nativeFilesystem ? "Native shell/filesystem capabilities are available through the harness; their tool names are provider-managed." : `Built-in tools: ${builtIns.length > 0 ? builtIns.join(", ") : "(none enabled by launch policy)"}.`}
${input.filesystemScope ? `Filesystem policy: ${input.filesystemScope}; approval policy: ${input.approvalPolicy ?? "unspecified"}. These policies constrain native operations; tool availability does not grant write access.` : ""}

Server-registered Leader tools:
${lines.length > 0 ? lines.join("\n") : "- (none)"}`;
}

export interface LeaderPromptSkill {
  id: string;
  name: string;
  description?: string | undefined;
}

export function buildLeaderSkillInventory(skills: readonly LeaderPromptSkill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((skill) =>
    `- \`${skill.id}\` — **${skill.name}**: ${skill.description?.trim() || "(no description)"}`
  );
  return `# Available Skills

Use \`load_skill\` with a catalog ID to read its parent instructions and sub-skill index when relevant. Follow the parent before loading a sub-skill. Attachments are references; use \`load_skill_attachment\` to read them. Retrieval uses this run’s frozen catalog and does not grant authoring permissions.\n\nPass exact IDs from this catalog to \`assign_task.skillIds\`. Pass \`skillValues\` only for templates with placeholders.

${lines.join("\n")}`;
}

export interface ComposeLeaderPromptInput extends LeaderCapabilityInput {
  promptFeatureIds?: readonly LeaderPromptFeatureId[] | undefined;
  skillsAddendum?: string | null | undefined;
  userPrefix?: string | null | undefined;
  roleSystemAddendum?: string | null | undefined;
  systemModelAddendum?: string | null | undefined;
}

export function composeLeaderPrompt(input: ComposeLeaderPromptInput): string {
  return [
    LEADER_PROMPT_CORE,
    ...buildLeaderPromptFeatures(input.promptFeatureIds ?? ["task_graph_planning"]),
    buildLeaderCapabilityInventory(input),
    ...input.registeredToolNames.filter(name => name === "load_procedure" || name.endsWith("__load_procedure")).slice(0, 1).map(buildLeaderProcedureDiscovery),
    clean(input.roleSystemAddendum),
    clean(input.skillsAddendum),
    clean(input.userPrefix),
    clean(input.systemModelAddendum),
  ].filter((part): part is string => Boolean(part)).join("\n\n");
}

interface LeaderPromptCustomizationEnvelope {
  version: 1;
  promptPrefix: string;
  /** Frozen, selected skill instructions; never includes the canonical core. */
  skillsAddendum: string;
}

export function encodeLeaderPromptCustomization(input: {
  promptPrefix?: string | null | undefined;
  skillsAddendum?: string | null | undefined;
}): string {
  const envelope: LeaderPromptCustomizationEnvelope = {
    version: 1,
    promptPrefix: clean(input.promptPrefix),
    skillsAddendum: clean(input.skillsAddendum),
  };
  return JSON.stringify(envelope);
}

/**
 * Read bounded customization fields from the structured client envelope.
 * Raw strings are still valid prefixes for non-UI callers, but can never
 * replace the canonical server prompt.
 */
export function decodeLeaderPromptCustomization(
  value: string | undefined,
): { promptPrefix: string; skillsAddendum: string } {
  if (!value) return { promptPrefix: "", skillsAddendum: "" };
  const parsed = parseLeaderPromptCustomization(value);
  if (parsed) {
    return {
      promptPrefix: parsed.promptPrefix.trim(),
      skillsAddendum: parsed.skillsAddendum.trim(),
    };
  }
  // Plain strings are user prefixes, never authoritative full prompts.
  return { promptPrefix: value.trim(), skillsAddendum: "" };
}

export function isLeaderPromptCustomizationEnvelope(value: string): boolean {
  return parseLeaderPromptCustomization(value) !== null;
}

function parseLeaderPromptCustomization(
  value: string,
): LeaderPromptCustomizationEnvelope | null {
  try {
    const parsed = JSON.parse(value) as Partial<LeaderPromptCustomizationEnvelope>;
    const keys = typeof parsed === "object" && parsed !== null
      ? Object.keys(parsed)
      : [];
    return parsed.version === 1 && typeof parsed.promptPrefix === "string"
      && typeof parsed.skillsAddendum === "string"
      && keys.length === 3
      && keys.every((key) => ["version", "promptPrefix", "skillsAddendum"].includes(key))
      ? parsed as LeaderPromptCustomizationEnvelope
      : null;
  } catch {
    return null;
  }
}

function clean(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
