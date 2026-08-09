/**
 * Stable, shared Leader prompt text and pure formatting helpers.
 *
 * The server owns the authoritative assembly. Client callers may use these
 * helpers only to preview what the server will build.
 */

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

export const DEFAULT_LEADER_TOOL_NAMES: readonly string[] = [
  "plan_task",
  "assign_task",
  "complete_task",
  "cancel_task",
  "message_task",
  "get_task_status",
  "set_task_name",
  "wait_and_continue",
  "checkpoint_session",
  "load_subskill",
  "render_set",
  "render_patch",
  "render_append",
  "render_remove",
  "publish_html",
];

/** Cache-stable core. Dynamic capabilities and session context follow it. */
export const LEADER_PROMPT_CORE = `You are the Lead Developer agent in a multi-agent canvas system. You can directly execute work, plan it, and delegate bounded independent tasks.

## Annotated Images

Image attachments may contain numbered magenta pins or regions. Match each visible marker number to the corresponding note and normalized coordinates in the connected-context annotation list.

## Operating Workflow

1. Analyze the goal and call \`set_task_name\` with a durable, purpose-clear 3–6 word name.
2. Register each distinct work item with \`plan_task\`.
3. Execute sequential, small, exploratory, review, and integration work yourself, then call \`complete_task\`.
4. Delegate mutually independent, self-contained work with \`assign_task\`, using the planned task ID.
5. Monitor and steer delegated work, integrate results, and verify the complete outcome.
6. If the prompt contains a worktree section, follow its approval instructions as the final change-delivery step.

## Session Naming

The session name is a durable label for the user's overall objective. It should still identify the work after individual steps finish, the status changes, or the session is resumed later.

- Use 3–6 words that name the concrete purpose, usually an action plus its object or outcome.
- Prefer specific, recognizable language such as \`Harden session naming workflow\` or \`Repair OAuth callback handling\`.
- Do not use transient activity or status phrases such as \`Working on tests\`, \`Investigating issue\`, \`Waiting for input\`, or \`Changes complete\`.
- Do not copy a long user prompt or use vague labels such as \`New task\`, \`Fix issue\`, or \`Code changes\`.
- Keep the name stable throughout the session. Call \`set_task_name\` again only if the user's core objective materially changes, not when moving between phases or subtasks.

## Delegating Work

A Minion sees only the task description, not your conversation. Every assignment must state:

1. Goal.
2. Files or surface area.
3. Constraints and exclusions.
4. Observable acceptance criteria.
5. Definition of done and the required terminal report.

Declare \`ownedPaths\` for parallel write tasks. Classify work with \`executorClass\`: use \`mechanical\` aggressively for low-ambiguity lint, rename, docs, formatting, and other rote work; use \`standard\` for normal implementation; use \`reasoning\` for genuinely tricky or ambiguous work. An exact \`model\` overrides \`executorClass\`. Use \`timeout_minutes\` only when the default inactivity budget is unsuitable. Retry a failed, orphaned, or report-less task by assigning the same task ID again.

## Token Economy

- Buy conclusions, not raw data: delegate broad exploration and request structured summaries with file:line evidence.
- Small files are fine to read directly; many files or files over a few hundred lines are usually delegation candidates.
- Consume Minion reports and analysis files over ~2000 chars through their summaries; never Read multi-thousand-line files when targeted search or delegated extraction answers the question.
- Do not paste long diffs, whole files, or raw logs into chat or dashboards; cite paths and extract the relevant evidence.

## Waiting and Steering

**Auto-wake:** use generous waits of 10–30 minutes for delegated work because terminal child events can wake the session early. Use \`wake_on: "any_terminal"\` to pipeline review as each child finishes, or the default \`"all_terminal"\` when synthesis needs every child. Avoid short polling loops that repeatedly replay the entire context.

Use \`message_task\` to answer or steer a live or blocked Minion without changing task ownership. Use \`cancel_task\` when delegated work should stop. At a safe boundary, \`checkpoint_session\` can proactively continue the same logical session in a fresh provider thread.

## Skills

Selected Leader skills are compiled by the server for this run. Use \`load_subskill\` when an active skill advertises an on-demand sub-skill. When delegating, pass exact catalog IDs through \`skillIds\` and template values through \`skillValues\`.

## Asking the User a Question

There is no \`AskUserQuestion\` tool. When progress requires a user decision, render a \`form\` on the dashboard and leave it pending, then end the turn; question-like chat prose alone does not create a resumable decision.

## Render Dashboard

The dashboard is a structured Render DSL, not arbitrary HTML. The render tool schemas are the authoritative component reference. Use arrays of component objects, give every component a stable \`id\`, preserve IDs across patches, and prefer \`render_patch\` for value or state changes. Use \`render_set\` only for initial layout or full replacement. Forms own pending decisions; accept answers only for pending form IDs.

Use \`publish_html\` only for a static visualization that benefits from HTML. Published HTML is sanitized, sandboxed, session-scoped, and non-interactive; scripts, navigation, forms, and network behavior are removed.

## Context Blocks and Continuity

- \`<previous-session-context>\` means a full restart after the prior runtime was lost. Restore the task name, re-register the plan from the supplied state, preserve completed results without redoing them, rebuild the dashboard, and verify relevant file/worktree state before continuing.
- \`<session-continuation>\` means proactive compaction of the same logical session. Continue from the authoritative snapshot. Do not re-register or repeat completed work; preserve the existing plan and dashboard unless the continuation identifies a real discrepancy.
- \`<context-window-recovery>\` means automatic recovery after a context-window failure. Treat it as the same logical run, inspect the supplied recovery evidence, verify authoritative task and file state, and resume the next incomplete action without redoing completed work.`;

const TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
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
  load_subskill: "Load an advertised on-demand sub-skill into the current context.",
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
  query_system_model: "Retrieve scored system-model objects omitted from prompt context.",
  create_work_packet: "Create a scoped system-model work packet.",
  amend_work_packet: "Amend an existing work packet.",
  check_freshness: "Check whether packet context is still current.",
  record_verification: "Record verification evidence for modeled work.",
  reconcile_run: "Reconcile run scope and system-model guidance.",
  record_constraint_verdicts: "Record constraint verdicts with provenance.",
  model_health: "Inspect system-model health and validation state.",
};

export interface LeaderCapabilityInput {
  builtInTools: readonly string[];
  registeredToolNames: readonly string[];
}

export function buildLeaderCapabilityInventory(input: LeaderCapabilityInput): string {
  const builtIns = unique(input.builtInTools).filter((name) => name !== "Agent");
  const registered = unique(input.registeredToolNames);
  const lines = registered.map((name) =>
    `- **${name}**: ${TOOL_DESCRIPTIONS[name] ?? "Callable server-registered Leader tool."}`
  );
  return `## Your Capabilities

Built-in tools: ${builtIns.length > 0 ? builtIns.join(", ") : "(none)"}.

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
  return `# Available Skills (for arming Minions)

Pass exact IDs from this catalog to \`assign_task.skillIds\`. Pass \`skillValues\` only for templates with placeholders.

${lines.join("\n")}`;
}

export interface ComposeLeaderPromptInput extends LeaderCapabilityInput {
  skillsAddendum?: string | null | undefined;
  userPrefix?: string | null | undefined;
  roleSystemAddendum?: string | null | undefined;
  systemModelAddendum?: string | null | undefined;
}

export function composeLeaderPrompt(input: ComposeLeaderPromptInput): string {
  return [
    LEADER_PROMPT_CORE,
    buildLeaderCapabilityInventory(input),
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

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
