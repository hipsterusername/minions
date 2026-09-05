import { persistContextSource } from "./context-source.ts";
import { recoveryTag, renderRecoveryFacts, type RecoveryFacts } from "../shared/recovery-context.ts";
import { boundHandoffText, renderConnectedHandoff, retainUserDirectives, userTextFromPrompt } from "../shared/handoff-text.ts";
import { persistenceDb } from "./session-persist.ts";
import { getSessionCanvasContext } from "./canvas-context-store.ts";
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
  connectedContext?: string | null;
  retainedState?: RecoveryFacts;
  connectedContextSourceRef?: string;
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
  const prior = host.contextCheckpoint;
  const semantic = parseHandoff(input.modelHandoff ?? "");
  const previousDirectives = host.continuity?.directives.length ? host.continuity.directives
    : prior?.userDirectives.length ? prior.userDirectives
      : (host.eventBuffer ?? []).flatMap(row => row.type === "sdk_event" && row.event?.kind === "text"
        && row.event.role === "user" ? [userTextFromPrompt(row.event.text)] : []);
  const directives = retainUserDirectives([...previousDirectives, userTextFromPrompt(prompt)]);
  const objective = directives[0] || prior?.objective.statement
    || host.taskName || "Continue the active objective.";
  const items = tasks.map(toWorkItem);
  const components = host.renderState?.components ?? [];
  const artifacts = collectArtifacts(tasks, components, host);
  const db = persistenceDb();
  if (db && db.name !== ":memory:") artifacts.unshift({ kind: "file", ref: `${db.name}: session_user_directives (full instructions, ordered by id) and session_continuity (full source snapshot); session_key=${host.id}` });
  const now = Date.now();
  const checkpoint: ContextCheckpoint = {
    version: 1,
    retainedState: { providerThread: "fresh_requested", taskRegistry: host.taskState ? "available_at_capture" : "unknown",
      dashboard: host.renderState ? "available_at_capture" : "unknown", worktree: host.worktree ? "recorded_at_capture" : "none_recorded" },
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
      acceptanceCriteria: unique([...(prior?.objective.acceptanceCriteria ?? []), ...tasks.flatMap((task) => task.acceptanceCriteria ?? [])]),
      scope: unique([...(prior?.objective.scope ?? []), ...tasks.flatMap((task) => task.files ?? [])]),
      exclusions: unique([...(prior?.objective.exclusions ?? []), ]),
    },
    progress: {
      completed: items.filter((item) => item.status === "completed"),
      inProgress: items.filter((item) => item.status === "running" || item.status === "starting"),
      remaining: items.filter((item) => !["completed", "cancelled"].includes(item.status)),
    },
    decisions: [...new Map([...(prior?.decisions ?? []), ...semantic.decisions.map(splitDecision)].map(d => [d.decision, d])).values()],
    constraints: unique([...(prior?.constraints ?? []), ...tasks.flatMap((task) => task.constraints ?? [])]),
    userDirectives: directives,
    negativeKnowledge: unique([...(prior?.negativeKnowledge ?? []), ...semantic.deadEnds]),
    openQuestions: semantic.openQuestions.length ? semantic.openQuestions : prior?.openQuestions ?? [],
    risks: semantic.risks.length ? semantic.risks : prior?.risks ?? [],
    activeArtifacts: artifacts,
    verification: items
      .filter((item) => item.status === "completed" && item.result)
      .map((item) => ({ target: item.taskId, result: item.result! })),
    nextActions: semantic.nextActions.length > 0
      ? semantic.nextActions
      : items.length ? items.filter((item) => !["completed", "cancelled"].includes(item.status)).slice(0, 5).map((item) => item.title)
        : prior?.nextActions ?? [],
    authoritativeSnapshot: {
      capturedAt: now,
      taskRevision: digest(tasks.map((task) => [task.taskId, task.status, task.completedAt])),
      renderRevision: digest(components),
      worktreeRevision: digest(host.worktree ?? null),
    },
    modelHandoff: truncateMiddle((/^Automatic checkpoint/.test(input.modelHandoff ?? "")
      ? prior?.modelHandoff : input.modelHandoff) || prior?.modelHandoff || "", MAX_HANDOFF_CHARS),
    recentEvents: collectRecentEvents(host.eventBuffer ?? []),
    connectedContext: host.continuity?.canvasContext !== undefined ? host.continuity.canvasContext
      : host.canvasContext ?? getSessionCanvasContext(host.id),
    recoveryCause: input.recoveryCause ? truncateMiddle(input.recoveryCause, 1_200) : null,
    usage: input.usage ?? null,
    qualityWarnings: [],
  };
  checkpoint.connectedContextSourceRef = persistContextSource(host.worktree?.projectPath ?? host.cwd, checkpoint.connectedContext);
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
    prompt: [renderCheckpointPrompt(checkpoint), checkpoint.connectedContext
      ? renderConnectedHandoff(checkpoint.connectedContext, checkpoint.connectedContextSourceRef) : ""].filter(Boolean).join("\n\n"),
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
    `<${recoveryTag(p.trigger)}>`,
    renderRecoveryFacts(p.retainedState ?? { providerThread: "unknown", taskRegistry: "unknown", dashboard: "unknown", worktree: "unknown" }),
    `Prior session id: ${p.sourceSessionId ?? "(unknown)"}`,
    `Session name: ${boundHandoffText(p.sessionName ?? "(unnamed)", 200)}`,
    "User directives are chronological; later corrections supersede earlier conflicting instructions. Model decisions and old evidence may be stale; verify before acting.",
    section("objective", [p.objective.statement, ...labeled("Acceptance criteria", p.objective.acceptanceCriteria), ...labeled("Scope", p.objective.scope), ...labeled("Exclusions", p.objective.exclusions)]),
    section("user-directives", p.userDirectives),

    section("task-registry", [
      ...p.progress.completed,
      ...p.progress.inProgress,
      ...p.progress.remaining.filter((item) => !p.progress.inProgress.some((active) => active.taskId === item.taskId)),
    ].map((item) => `${item.taskId} [${item.status}] ${item.title}; executor=${item.executor}${item.result ? ` result=${JSON.stringify(item.result)}` : ""}`)),
    section("constraints", p.constraints),
    section("decisions", p.decisions.map((d) => `${d.decision}${d.rationale ? ` — because ${d.rationale}` : ""}`)),
    section("next-actions", ["Supplemental proposed actions; reconcile with current user/runtime constraints.", ...p.nextActions]),
    section("open-questions-and-risks", [...p.openQuestions, ...p.risks]),
    section("negative-knowledge", p.negativeKnowledge),
    section("active-artifacts", p.activeArtifacts.filter(a => a.kind === "file").map((a) => `${a.kind}: ${a.ref}`)),
    section("dashboard-components", p.activeArtifacts.filter((a) => a.kind === "dashboard").map((a) => a.ref)),
    section("worktree", p.activeArtifacts.filter((a) => a.kind === "worktree").flatMap((a) => [a.ref, `branch: ${a.ref.match(/\((.+)\)$/)?.[1] ?? "(unknown)"}`])),
    section("verification", p.verification.map((v) => `${v.target}: reported result in task-registry; independently verify before relying on it.`)),
    section("recent-events", p.recentEvents),
    p.recoveryCause ? section("recovery-cause", [p.recoveryCause]) : "",
    p.modelHandoff ? section("model-authored-handoff", [p.modelHandoff]) : "",
    section("checkpoint-quality", p.qualityWarnings),
    `</${recoveryTag(p.trigger)}>`,
    "</context-checkpoint>",
  ];
  const rendered = sections.filter(Boolean).join("\n");
  if (rendered.length > MAX_PROMPT_CHARS) throw new Error("Checkpoint section budgets exceeded");
  return rendered;
}

export function validateCheckpoint(checkpoint: ContextCheckpoint): string[] {
  const warnings: string[] = [];
  if (!checkpoint.objective.statement.trim()) warnings.push("Objective was missing and must be confirmed.");
  if (checkpoint.nextActions.length === 0 && checkpoint.progress.remaining.length > 0) warnings.push("Remaining work has no explicit next action.");
  const completed = new Set(checkpoint.progress.completed.map((item) => item.taskId));
  if (checkpoint.progress.remaining.some((item) => completed.has(item.taskId))) warnings.push("A task appears in both completed and remaining state.");
  if (!checkpoint.modelHandoff && checkpoint.trigger === "proactive") warnings.push("Automatic checkpoint: no model-authored semantic handoff was captured; inspect recent evidence before acting.");
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
  if (event.kind === "text") return `${event.role}: ${event.text}`;
  if (event.kind === "tool_call") return `tool ${event.name}: ${safeJson(event.input)}`;
  if (event.kind === "tool_result") return `tool result${event.isError ? " (error)" : ""}: ${safeJson(event.output)}`;
  if (event.kind === "agent_task_update") return `task ${event.taskId} ${event.status}: ${event.summary}`;
  return "";
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
  const budgets: Record<string, number> = {
    objective: 1_500, "user-directives": 7_000, constraints: 2_000, "next-actions": 1_500,
    "active-artifacts": 3_000, "task-registry": 1_500, decisions: 500,
    "model-authored-handoff": 1_200, "recent-events": 600,
  };
  return [`<${name}>`, boundHandoffText(rows.map(row => `- ${row}`).join("\n"), budgets[name] ?? 300), `</${name}>`].join("\n");
}

function labeled(label: string, values: string[]): string[] { return values.map((value) => `${label}: ${value}`); }
function unique(values: string[]): string[] { return [...new Set(values.map((v) => v.trim()).filter(Boolean))]; }
function digest(value: unknown): string { const text = safeJson(value); let hash = 2166136261; for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619); return (hash >>> 0).toString(16); }
function safeJson(value: unknown): string { try { return JSON.stringify(value); } catch { return String(value); } }
function truncateMiddle(text: string, max: number): string { if (text.length <= max) return text; const mark = "\n[... checkpoint content omitted ...]\n"; const head = Math.ceil((max - mark.length) * .6); const tail = Math.floor((max - mark.length) * .4); return text.slice(0, head) + mark + text.slice(-tail); }
