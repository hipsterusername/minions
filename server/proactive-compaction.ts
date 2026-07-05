import type { NormalizedEvent } from "../shared/normalized-event.ts";
import type { RenderComponent } from "../shared/render-dsl.ts";
import type { Bus } from "./bus.ts";
import type { SessionHost, StartSessionOptions } from "./session-host.ts";
import type { TaskRecord } from "./task-tools.ts";
import { capTaskTextForSummary } from "./task-tools/result-summary.ts";
import {
  DEFAULT_PROACTIVE_COMPACTION,
  evaluateCompactionUsage,
  initialCompactionAdvisorState,
  type CompactionAdvice,
  type CompactionAdvisorState,
  type ProactiveCompactionSetting,
} from "./compaction-advisor.ts";
import {
  consumeCheckpointHandoff,
  isCheckpointRequested,
} from "./task-tools/checkpoint-session.ts";
import { readSettings } from "./project-store.ts";

const MAX_HANDOFF_CHARS = 4_000;
const MAX_SEED_PROMPT_CHARS = 24_000;
const MAX_TASK_RESULT_CHARS = 800;
const RECOMMEND_REMINDER =
  "System reminder: Context is above the proactive checkpoint recommendation threshold. Call `checkpoint_session` at the next safe boundary to continue in a fresh thread.";

export interface ProactiveCompactionState {
  setting: ProactiveCompactionSetting;
  /** True once `setting` has been resolved from project settings (or set explicitly). */
  settingResolved: boolean;
  advisor: CompactionAdvisorState;
  recommended: CompactionAdvice | null;
  forcePending: CompactionAdvice | null;
  handoffText: string;
  oldSessionIds: string[];
}

export function createProactiveCompactionState(): ProactiveCompactionState {
  return {
    setting: DEFAULT_PROACTIVE_COMPACTION,
    settingResolved: false,
    advisor: initialCompactionAdvisorState(),
    recommended: null,
    forcePending: null,
    handoffText: "",
    oldSessionIds: [],
  };
}

function parseCompactionSetting(raw: unknown): ProactiveCompactionSetting {
  return raw === "off" || raw === "recommend" || raw === "auto"
    ? raw
    : DEFAULT_PROACTIVE_COMPACTION;
}

/**
 * Resolve the `proactiveCompaction` project setting once per session,
 * lazily on the first usage event. An explicit assignment that also sets
 * `settingResolved` wins over project settings.
 */
function ensureSettingResolved(host: SessionHost): void {
  const state = host.proactiveCompaction;
  if (state.settingResolved) return;
  state.settingResolved = true;
  const projectPath = host.worktree?.projectPath ?? host.cwd;
  state.setting = parseCompactionSetting(
    readSettings(projectPath).proactiveCompaction,
  );
}

export function recordCompactionUsage(
  host: SessionHost,
  usage: Extract<NormalizedEvent, { kind: "usage" }>,
): void {
  if (host.role !== "leader") return;
  ensureSettingResolved(host);
  const state = host.proactiveCompaction;
  if (state.setting === "off") return;
  const advice = evaluateCompactionUsage(state.advisor, usage, host.model);
  if (advice.action === "recommend") state.recommended = advice;
  if (advice.action === "force" && state.setting === "recommend") {
    state.recommended = advice;
  }
  if (advice.action === "force" && state.setting === "auto") {
    state.forcePending = advice;
  }
}

export function withCompactionReminder(
  host: SessionHost,
  prompt: string | AsyncIterable<{ role: "user"; content: string }>,
): string | AsyncIterable<{ role: "user"; content: string }> {
  if (typeof prompt !== "string") return prompt;
  const state = host.proactiveCompaction;
  if (!state) return prompt;
  if (!state.recommended || state.setting === "off") return prompt;
  const pct = Math.round(state.recommended.ratio * 100);
  state.recommended = null;
  return `${prompt}\n\n${RECOMMEND_REMINDER.replace("above", `at ${pct}% of`)}`;
}

export function captureCheckpointHandoffEvent(
  host: SessionHost,
  event: NormalizedEvent,
): void {
  if (!isCheckpointRequested(host.id)) return;
  if (event.kind === "text" && event.role === "assistant") {
    appendHandoff(host, event.text);
  } else if (event.kind === "text_delta" && !event.parentId) {
    appendHandoff(host, event.text);
  }
}

export function buildPendingCompactionStartOptions(
  host: SessionHost,
  opts: StartSessionOptions,
): StartSessionOptions | null {
  if (host.role !== "leader") return null;
  const handoff = consumeCheckpointHandoff(host.id) ?? autoHandoff(host);
  const manual = host.proactiveCompaction.handoffText.trim();
  const forced = host.proactiveCompaction.forcePending;
  if (!manual && !forced && !handoff) return null;
  if (host.proactiveCompaction.forcePending && !isSafeToAutoCompact(host)) {
    return null;
  }
  const priorSessionId = host.sessionId;
  if (priorSessionId) host.proactiveCompaction.oldSessionIds.push(priorSessionId);
  host.proactiveCompaction.forcePending = null;
  host.proactiveCompaction.handoffText = "";
  return {
    ...opts,
    prompt: buildProactiveCompactionSeed(
      host,
      manual || handoff || "Automatic checkpoint at idle boundary.",
    ),
    resumeId: undefined,
    contextRecoveryAttempt: undefined,
  };
}

export function emitSessionCompacted(
  host: SessionHost,
  deps: { bus: Bus },
  oldSessionId: string | null,
  advice: CompactionAdvice | null,
): void {
  deps.bus.emitToSession(host.id, {
    type: "session_compacted",
    sessionKey: host.id,
    oldSessionId,
    newSessionId: host.sessionId,
    contextTokensBefore: advice?.contextTokens,
    contextWindowTokens: advice?.contextWindowTokens,
    ratioBefore: advice?.ratio,
    timestamp: Date.now(),
  });
}

export function buildProactiveCompactionSeed(
  host: SessionHost,
  handoff: string,
): string {
  const sections = [
    "<previous-session-context>",
    `Prior session id: ${host.sessionId ?? "(unknown)"}`,
    `Session name: ${host.taskName ?? "(unnamed)"}`,
    renderTasks(host.taskState?.tasks.values() ?? []),
    renderDashboardInventory(host.renderState?.components ?? []),
    renderWorktree(host),
    "<model-authored-handoff>",
    truncate(handoff, MAX_HANDOFF_CHARS),
    "</model-authored-handoff>",
    "</previous-session-context>",
  ];
  return truncate(sections.filter(Boolean).join("\n"), MAX_SEED_PROMPT_CHARS);
}

function appendHandoff(host: SessionHost, text: string): void {
  host.proactiveCompaction.handoffText = truncate(
    `${host.proactiveCompaction.handoffText}${text}`,
    MAX_HANDOFF_CHARS,
  );
}

function autoHandoff(host: SessionHost): string | null {
  if (!host.proactiveCompaction.forcePending) return null;
  return "Automatic checkpoint at the force threshold. Continue from the server-authoritative state snapshot and avoid repeating completed work.";
}

function isSafeToAutoCompact(host: SessionHost): boolean {
  const taskState = host.taskState;
  if (taskState?.approval?.requested) return false;
  if (taskState?.pendingWait?.wakeOn === "any_terminal") return false;
  return true;
}

function renderTasks(tasks: Iterable<TaskRecord>): string {
  const lines = ["<task-registry>"];
  for (const task of tasks) {
    const result = task.result
      ? ` result=${JSON.stringify(capTaskTextForSummary(task.result, MAX_TASK_RESULT_CHARS, "result"))}`
      : "";
    lines.push(
      `- ${task.taskId} [${task.status}] ${task.title}; executor=${task.executor}${result}`,
    );
  }
  lines.push("</task-registry>");
  return lines.length > 2 ? lines.join("\n") : "";
}

function renderDashboardInventory(components: RenderComponent[]): string {
  const rows: string[] = [];
  walkComponents(components, rows);
  return rows.length
    ? ["<dashboard-components>", ...rows, "</dashboard-components>"].join("\n")
    : "";
}

function walkComponents(components: RenderComponent[], rows: string[]): void {
  for (const component of components) {
    rows.push(`- ${component.id}: ${component.type}`);
    if (component.type === "section") walkComponents(component.components, rows);
    if (component.type === "tabs") {
      for (const tab of component.tabs) walkComponents(tab.components, rows);
    }
  }
}

function renderWorktree(host: SessionHost): string {
  if (!host.worktree) return "";
  return [
    "<worktree>",
    `cwd: ${host.cwd}`,
    `branch: ${host.worktree.branch}`,
    `path: ${host.worktree.path}`,
    `projectPath: ${host.worktree.projectPath}`,
    "</worktree>",
  ].join("\n");
}

function truncate(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, maxChars).join("")}\n[... truncated for proactive compaction ...]`;
}
