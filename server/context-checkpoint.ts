import { randomUUID } from "node:crypto";
import type { NormalizedEvent } from "../shared/normalized-event.ts";
import type { RenderComponent } from "../shared/render-dsl.ts";
import type { SessionHost, StartSessionOptions } from "./session-host.ts";
import type { BufferedEvent } from "./session-host-config.ts";
import type { TaskRecord } from "./task-tools.ts";
import { capTaskTextForSummary } from "./task-tools/result-summary.ts";
import { persistContextCheckpoint } from "./context-checkpoint-store.ts";
import type { CompactionAdvice } from "./compaction-advisor.ts";

const MAX_PROMPT_CHARS = 24_000;
const MAX_HANDOFF_CHARS = 4_000;
const MAX_RESULT_CHARS = 800;
const MAX_EVENT_CHARS = 8_000;

export type CheckpointTrigger = "proactive" | "context_recovery";
export type CheckpointStatus = "prepared" | "committed" | "failed";

export interface CheckpointWorkItem {
  taskId: string;
  title: string;
  status: TaskRecord["status"];
  executor: TaskRecord["executor"];
  result: string | null;
  evidence: string[];
}

export interface ContextCheckpoint {
  version: 1;
  checkpointId: string;
  sessionKey: string;
  sessionName: string | null;
  sourceSessionId: string | null;
  targetSessionId: string | null;
  trigger: CheckpointTrigger;
  status: CheckpointStatus;
  createdAt: number;
  committedAt: number | null;
  failedAt: number | null;
  failureReason: string | null;
  objective: {
    statement: string;
    acceptanceCriteria: string[];
    scope: string[];
    exclusions: string[];
  };
  progress: {
    completed: CheckpointWorkItem[];
    inProgress: CheckpointWorkItem[];
    remaining: CheckpointWorkItem[];
  };
  decisions: Array<{ decision: string; rationale: string }>;
  constraints: string[];
  userDirectives: string[];
  negativeKnowledge: string[];
  openQuestions: string[];
  risks: string[];
  activeArtifacts: Array<{ kind: "file" | "dashboard" | "worktree"; ref: string }>;
  verification: Array<{ target: string; result: string }>;
  nextActions: string[];
  authoritativeSnapshot: {
    capturedAt: number;
    taskRevision: string;
    renderRevision: string;
    worktreeRevision: string;
  };
  modelHandoff: string;
  recentEvents: string[];
  recoveryCause: string | null;
  usage: CompactionAdvice | null;
  qualityWarnings: string[];
}

export interface CompileCheckpointInput {
  trigger: CheckpointTrigger;
  originalPrompt: StartSessionOptions["prompt"];
  modelHandoff?: string;
  recoveryCause?: string;
  usage?: CompactionAdvice | null;
  /** Pure callers (preview/tests) can compile without writing an audit row. */
  persist?: boolean;
}

export function compileContextCheckpoint(
  host: SessionHost,
  input: CompileCheckpointInput,
): ContextCheckpoint {
  const tasks = [...(host.taskState?.tasks.values() ?? [])];
  const prompt = typeof input.originalPrompt === "string" ? input.originalPrompt.trim() : "";
  const semantic = parseHandoff(input.modelHandoff ?? "");
  const objective = semantic.goal[0] ?? host.taskName ?? prompt ?? "Continue the active objective.";
  const items = tasks.map(toWorkItem);
  const components = host.renderState?.components ?? [];
  const artifacts = collectArtifacts(tasks, components, host);
  const now = Date.now();
  const checkpoint: ContextCheckpoint = {
    version: 1,
    checkpointId: randomUUID(),
    sessionKey: host.id,
    sessionName: host.taskName,
    sourceSessionId: host.sessionId,
    targetSessionId: null,
    trigger: input.trigger,
    status: "prepared",
    createdAt: now,
    committedAt: null,
    failedAt: null,
    failureReason: null,
    objective: {
      statement: objective,
      acceptanceCriteria: unique(tasks.flatMap((task) => task.acceptanceCriteria ?? [])),
      scope: unique(tasks.flatMap((task) => task.files ?? [])),
      exclusions: semantic.exclusions,
    },
    progress: {
      completed: items.filter((item) => item.status === "completed"),
      inProgress: items.filter((item) => item.status === "running" || item.status === "starting"),
      remaining: items.filter((item) => !["completed", "cancelled"].includes(item.status)),
    },
    decisions: semantic.decisions.map((decision) => splitDecision(decision)),
    constraints: unique(tasks.flatMap((task) => task.constraints ?? []).concat(semantic.constraints)),
    userDirectives: prompt ? [truncateMiddle(prompt, 2_000)] : [],
    negativeKnowledge: semantic.deadEnds,
    openQuestions: semantic.openQuestions,
    risks: semantic.risks,
    activeArtifacts: artifacts,
    verification: items
      .filter((item) => item.status === "completed" && item.result)
      .map((item) => ({ target: item.taskId, result: item.result! })),
    nextActions: semantic.nextActions.length > 0
      ? semantic.nextActions
      : items.filter((item) => !["completed", "cancelled"].includes(item.status)).slice(0, 5).map((item) => item.title),
    authoritativeSnapshot: {
      capturedAt: now,
      taskRevision: digest(tasks.map((task) => [task.taskId, task.status, task.completedAt])),
      renderRevision: digest(components),
      worktreeRevision: digest(host.worktree ?? null),
    },
    modelHandoff: truncateMiddle(input.modelHandoff ?? "", MAX_HANDOFF_CHARS),
    recentEvents: input.trigger === "context_recovery" ? collectRecentEvents(host.eventBuffer) : [],
    recoveryCause: input.recoveryCause ? truncateMiddle(input.recoveryCause, 1_200) : null,
    usage: input.usage ?? null,
    qualityWarnings: [],
  };
  checkpoint.qualityWarnings = validateCheckpoint(checkpoint);
  if (input.persist !== false) persistContextCheckpoint(checkpoint);
  return checkpoint;
}

export function checkpointStartOptions(
  checkpoint: ContextCheckpoint,
  opts: StartSessionOptions,
): StartSessionOptions {
  return {
    ...opts,
    invocationKind: "provider_continuation",
    prompt: renderCheckpointPrompt(checkpoint),
    resumeId: undefined,
    contextRecoveryAttempt: checkpoint.trigger === "context_recovery"
      ? (opts.contextRecoveryAttempt ?? 0) + 1
      : undefined,
    contextCheckpointId: checkpoint.checkpointId,
  };
}

export function commitContextCheckpoint(
  checkpoint: ContextCheckpoint,
  targetSessionId: string,
): void {
  checkpoint.status = "committed";
  checkpoint.targetSessionId = targetSessionId;
  checkpoint.committedAt = Date.now();
  checkpoint.failedAt = null;
  checkpoint.failureReason = null;
  persistContextCheckpoint(checkpoint);
}

export function failContextCheckpoint(checkpoint: ContextCheckpoint, reason: string): void {
  if (checkpoint.status === "committed") return;
  checkpoint.status = "failed";
  checkpoint.failedAt = Date.now();
  checkpoint.failureReason = truncateMiddle(reason, 1_200);
  persistContextCheckpoint(checkpoint);
}

export function renderCheckpointPrompt(checkpoint: ContextCheckpoint): string {
  const p = checkpoint;
  const sections = [
    `<context-checkpoint version="${p.version}" id="${p.checkpointId}" trigger="${p.trigger}">`,
    p.trigger === "proactive" ? "<session-continuation>" : "<previous-session-context>",
    p.trigger === "proactive"
      ? "This is the same logical session continuing in a fresh provider thread after proactive compaction. Continue the objective. Do NOT re-register completed work; the task registry and dashboard are still live."
      : "This is the same logical session in a fresh provider thread. Continue the objective without repeating completed work. Treat the authoritative sections as facts and the model handoff as supplemental.",
    `Prior session id: ${p.sourceSessionId ?? "(unknown)"}`,
    `Session name: ${p.sessionName ?? "(unnamed)"}`,
    section("objective", [p.objective.statement, ...labeled("Acceptance criteria", p.objective.acceptanceCriteria), ...labeled("Scope", p.objective.scope), ...labeled("Exclusions", p.objective.exclusions)]),
    section("user-directives", p.userDirectives),
    renderProgress(p),
    section("task-registry", [
      ...p.progress.completed,
      ...p.progress.inProgress,
      ...p.progress.remaining.filter((item) => !p.progress.inProgress.some((active) => active.taskId === item.taskId)),
    ].map((item) => `${item.taskId} [${item.status}] ${item.title}; executor=${item.executor}${item.result ? ` result=${JSON.stringify(item.result)}` : ""}`)),
    section("constraints", p.constraints),
    section("decisions", p.decisions.map((d) => `${d.decision}${d.rationale ? ` — because ${d.rationale}` : ""}`)),
    section("next-actions", p.nextActions),
    section("open-questions-and-risks", [...p.openQuestions, ...p.risks]),
    section("negative-knowledge", p.negativeKnowledge),
    section("active-artifacts", p.activeArtifacts.map((a) => `${a.kind}: ${a.ref}`)),
    section("dashboard-components", p.activeArtifacts.filter((a) => a.kind === "dashboard").map((a) => a.ref)),
    section("worktree", p.activeArtifacts.filter((a) => a.kind === "worktree").flatMap((a) => [a.ref, `branch: ${a.ref.match(/\((.+)\)$/)?.[1] ?? "(unknown)"}`])),
    section("verification", p.verification.map((v) => `${v.target}: ${v.result}`)),
    section("recent-events", p.recentEvents),
    p.recoveryCause ? section("recovery-cause", [p.recoveryCause]) : "",
    p.modelHandoff ? section("model-authored-handoff", [p.modelHandoff]) : "",
    section("checkpoint-quality", p.qualityWarnings),
    p.trigger === "proactive" ? "</session-continuation>" : "</previous-session-context>",
    "</context-checkpoint>",
  ];
  return truncateMiddle(sections.filter(Boolean).join("\n"), MAX_PROMPT_CHARS);
}

export function validateCheckpoint(checkpoint: ContextCheckpoint): string[] {
  const warnings: string[] = [];
  if (!checkpoint.objective.statement.trim()) warnings.push("Objective was missing and must be confirmed.");
  if (checkpoint.nextActions.length === 0 && checkpoint.progress.remaining.length > 0) warnings.push("Remaining work has no explicit next action.");
  const completed = new Set(checkpoint.progress.completed.map((item) => item.taskId));
  if (checkpoint.progress.remaining.some((item) => completed.has(item.taskId))) warnings.push("A task appears in both completed and remaining state.");
  if (!checkpoint.modelHandoff && checkpoint.trigger === "proactive") warnings.push("No model-authored semantic handoff was captured.");
  return warnings;
}

function toWorkItem(task: TaskRecord): CheckpointWorkItem {
  const result = task.result ? capTaskTextForSummary(task.result, MAX_RESULT_CHARS, "result") : null;
  return { taskId: task.taskId, title: task.title, status: task.status, executor: task.executor, result, evidence: unique(task.files ?? []) };
}

function collectArtifacts(tasks: TaskRecord[], components: RenderComponent[], host: SessionHost): ContextCheckpoint["activeArtifacts"] {
  const result: ContextCheckpoint["activeArtifacts"] = [];
  for (const file of unique(tasks.flatMap((task) => task.files ?? []))) result.push({ kind: "file", ref: file });
  walkComponents(components, (component) => result.push({ kind: "dashboard", ref: `${component.id}: ${component.type}` }));
  if (host.worktree) result.push({ kind: "worktree", ref: `${host.worktree.path} (${host.worktree.branch})` });
  return result;
}

function walkComponents(components: RenderComponent[], visit: (component: RenderComponent) => void): void {
  for (const component of components) {
    visit(component);
    if (component.type === "section") walkComponents(component.components, visit);
    if (component.type === "tabs") for (const tab of component.tabs) walkComponents(tab.components, visit);
  }
}

function collectRecentEvents(events: readonly BufferedEvent[]): string[] {
  const rows: string[] = [];
  let chars = 0;
  for (let i = events.length - 1; i >= 0 && chars < MAX_EVENT_CHARS; i--) {
    const buffered = events[i];
    if (buffered?.type !== "sdk_event" || !buffered.event) continue;
    const row = renderEvent(buffered.event);
    if (!row) continue;
    const capped = truncateMiddle(row, Math.min(1_200, MAX_EVENT_CHARS - chars));
    rows.unshift(capped);
    chars += capped.length;
  }
  return rows;
}

function renderEvent(event: NormalizedEvent): string {
  if (event.kind === "text" && event.role === "assistant") return `assistant: ${event.text}`;
  if (event.kind === "tool_call") return `tool ${event.name}: ${safeJson(event.input)}`;
  if (event.kind === "tool_result") return `tool result${event.isError ? " (error)" : ""}: ${safeJson(event.output)}`;
  if (event.kind === "agent_task_update") return `task ${event.taskId} ${event.status}: ${event.summary}`;
  return "";
}

function renderProgress(checkpoint: ContextCheckpoint): string {
  const rows = [
    ...checkpoint.progress.completed.map((i) => `completed ${i.taskId}: ${i.title}${i.result ? ` — ${i.result}` : ""}`),
    ...checkpoint.progress.inProgress.map((i) => `in progress ${i.taskId}: ${i.title}`),
    ...checkpoint.progress.remaining.filter((i) => !checkpoint.progress.inProgress.some((a) => a.taskId === i.taskId)).map((i) => `remaining ${i.taskId}: ${i.title}`),
  ];
  return section("authoritative-progress", rows);
}

function parseHandoff(text: string): Record<"goal" | "decisions" | "deadEnds" | "openQuestions" | "nextActions" | "constraints" | "risks" | "exclusions", string[]> {
  type SemanticKey = "goal" | "decisions" | "deadEnds" | "openQuestions" | "nextActions" | "constraints" | "risks" | "exclusions";
  const result: Record<SemanticKey, string[]> = { goal: [], decisions: [], deadEnds: [], openQuestions: [], nextActions: [], constraints: [], risks: [], exclusions: [] };
  const aliases: Array<[RegExp, keyof typeof result]> = [
    [/^goal|objective$/i, "goal"], [/^decisions?/i, "decisions"], [/^dead ends?|negative knowledge|failed approaches?/i, "deadEnds"],
    [/^open (threads|questions?)/i, "openQuestions"], [/^next (steps?|actions?)/i, "nextActions"], [/^constraints?/i, "constraints"], [/^risks?/i, "risks"], [/^exclusions?/i, "exclusions"],
  ];
  let active: keyof typeof result | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*]\s+/, "");
    if (!line) continue;
    const heading = line.match(/^#{0,3}\s*([^:]+):?\s*(.*)$/);
    const found = heading && aliases.find(([pattern]) => pattern.test(heading[1]!.trim()));
    if (found) { active = found[1]; if (heading![2]!.trim()) result[active].push(heading![2]!.trim()); continue; }
    if (active) result[active].push(line);
  }
  return result;
}

function splitDecision(text: string): { decision: string; rationale: string } {
  const parts = text.split(/\s+(?:because|rationale:)\s+/i, 2);
  return { decision: parts[0] ?? text, rationale: parts[1] ?? "" };
}

function section(name: string, rows: string[]): string {
  if (rows.length === 0) return "";
  return [`<${name}>`, ...rows.map((row) => `- ${row}`), `</${name}>`].join("\n");
}

function labeled(label: string, values: string[]): string[] { return values.map((value) => `${label}: ${value}`); }
function unique(values: string[]): string[] { return [...new Set(values.map((v) => v.trim()).filter(Boolean))]; }
function digest(value: unknown): string { const text = safeJson(value); let hash = 2166136261; for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619); return (hash >>> 0).toString(16); }
function safeJson(value: unknown): string { try { return JSON.stringify(value); } catch { return String(value); } }
function truncateMiddle(text: string, max: number): string { if (text.length <= max) return text; const mark = "\n[... checkpoint content omitted ...]\n"; const head = Math.ceil((max - mark.length) * .6); const tail = Math.floor((max - mark.length) * .4); return text.slice(0, head) + mark + text.slice(-tail); }
