/**
 * Context-window recovery helpers for SessionHost.
 *
 * Extracted from `session-host-run.ts` to keep that module under the
 * 400-line architecture ceiling.
 *
 * Handles detecting context-window overflow errors and building a
 * compacted continuation prompt so the session can resume in a fresh
 * thread without losing task state.
 */

import type { NormalizedEvent } from "../shared/normalized-event.ts";
import type { SessionHost, StartSessionOptions } from "./session-host.ts";
import type { TaskManagerState, TaskRecord } from "./task-tools.ts";
import type { BufferedEvent } from "./session-host-config.ts";
import {
  summarizeReasoningMap,
  type ReasoningMapState,
} from "../shared/reasoning-map.ts";

// ── Constants ───────────────────────────────────────────────────────────────

const CONTEXT_WINDOW_PATTERNS = [
  /ran out of room in the model'?s context window/i,
  /context window/i,
  /context length/i,
  /maximum context/i,
  /too many tokens/i,
];

const MAX_RECOVERY_PROMPT_CHARS = 24_000;
const MAX_RECENT_EVENT_CHARS = 14_000;
const MAX_ORIGINAL_PROMPT_CHARS = 8_000;
const MAX_TASK_RESULT_CHARS = 800;

// ── Public API ──────────────────────────────────────────────────────────────

export function isContextWindowError(event: NormalizedEvent): boolean {
  if (event.kind !== "done" || event.reason !== "error") return false;
  const text = `${event.error ?? ""}\n${event.fullError ?? ""}`;
  return CONTEXT_WINDOW_PATTERNS.some((pattern) => pattern.test(text));
}

export function shouldRecoverFromContextWindow(
  opts: StartSessionOptions,
  event: NormalizedEvent,
): boolean {
  return (
    Boolean(opts.resumeId) &&
    (opts.contextRecoveryAttempt ?? 0) < 1 &&
    isContextWindowError(event)
  );
}

export function buildContextRecoveryStartOptions(
  host: SessionHost,
  opts: StartSessionOptions,
  event: Extract<NormalizedEvent, { kind: "done" }>,
): StartSessionOptions {
  return {
    ...opts,
    prompt: buildContextRecoveryPrompt(host, opts.prompt, event),
    resumeId: undefined,
    contextRecoveryAttempt: (opts.contextRecoveryAttempt ?? 0) + 1,
  };
}

// ── Private helpers ─────────────────────────────────────────────────────────

function buildContextRecoveryPrompt(
  host: SessionHost,
  originalPrompt: StartSessionOptions["prompt"],
  event: Extract<NormalizedEvent, { kind: "done" }>,
): string {
  const original =
    typeof originalPrompt === "string"
      ? truncateMiddle(originalPrompt, MAX_ORIGINAL_PROMPT_CHARS)
      : "Continue the pending user turn. The original prompt was streamed and is not available for exact replay.";

  const sections = [
    "<context-window-recovery>",
    "The previous agent thread exceeded the model context window. This is a fresh thread with compacted state from the prior run.",
    "Continue from this state. Do not repeat completed work. Preserve task IDs and update the existing task plan via tools when needed.",
    "",
    `Prior session id: ${host.sessionId ?? "(unknown)"}`,
    `Session name: ${host.taskName ?? "(unnamed)"}`,
    `Recovery cause: ${truncateMiddle(event.fullError ?? event.error ?? "context window exceeded", 1200)}`,
    "",
    renderTaskState(host.taskState),
    renderReasoningMapState(host.reasoningMapState),
    renderRecentEvents(host.eventBuffer),
    "</context-window-recovery>",
    "",
    "<current-user-turn>",
    original,
    "</current-user-turn>",
  ];

  return truncateMiddle(
    sections.filter((part) => part.trim().length > 0).join("\n"),
    MAX_RECOVERY_PROMPT_CHARS,
  );
}

function renderTaskState(taskState: TaskManagerState | null): string {
  if (!taskState || taskState.tasks.size === 0) return "";
  const lines = ["<task-plan>"];
  for (const task of taskState.tasks.values()) {
    lines.push(renderTask(task));
  }
  if (taskState.pendingWait) {
    lines.push(
      `Pending wait: ${taskState.pendingWait.reason} (${Math.round(
        taskState.pendingWait.durationMs / 1000,
      )}s)`,
    );
  }
  if (taskState.approval?.requested) {
    lines.push(`Approval pending: ${taskState.approval.summary}`);
  }
  lines.push("</task-plan>");
  return lines.join("\n");
}

function renderTask(task: TaskRecord): string {
  const result = task.result
    ? ` Result: ${truncateMiddle(task.result, MAX_TASK_RESULT_CHARS)}`
    : "";
  const assignee = task.minionSessionKey
    ? ` minion=${task.minionSessionKey}`
    : ` executor=${task.executor}`;
  return `- ${task.taskId} [${task.status}] (${task.priority})${assignee}: ${task.title}. ${task.description}${result}`;
}

function renderReasoningMapState(state: ReasoningMapState | null): string {
  if (!state || state.maps.length === 0) return "";
  const lines = ["<reasoning-graph>"];
  for (const map of state.maps) {
    const summary = map.finalSummary ?? summarizeReasoningMap(map, 1200).summary;
    const active = state.activeMapId === map.id ? " active" : "";
    lines.push(`- ${map.id} [${map.status}${active}]: ${truncateMiddle(summary, 1400)}`);
  }
  lines.push("</reasoning-graph>");
  return lines.join("\n");
}

function renderRecentEvents(events: readonly BufferedEvent[]): string {
  const lines: string[] = ["<recent-session-events>"];
  let remaining = MAX_RECENT_EVENT_CHARS;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]?.event;
    if (!event) continue;
    const rendered = renderRecentEvent(event);
    if (!rendered) continue;
    const entry = truncateMiddle(rendered, Math.min(1400, remaining));
    if (entry.length > remaining) break;
    lines.push(entry);
    remaining -= entry.length;
    if (remaining <= 0) break;
  }
  if (lines.length === 1) return "";
  const body = lines.slice(1).reverse();
  return ["<recent-session-events>", ...body, "</recent-session-events>"].join("\n");
}

function renderRecentEvent(event: NormalizedEvent): string {
  switch (event.kind) {
    case "text":
      return `[assistant]: ${event.text}`;
    case "thinking":
      return `[thinking]: ${event.text}`;
    case "tool_call":
      return `[tool_call ${event.name} ${event.id}]: ${stringifyForPrompt(event.input)}`;
    case "tool_result":
      return `[tool_result ${event.callId}${event.isError ? " error" : ""}]: ${stringifyForPrompt(event.output)}`;
    case "agent_spawned":
      return `[agent_spawned ${event.taskId}]: ${event.description}`;
    case "agent_task_update":
      return `[agent_task_update ${event.taskId} ${event.status}]: ${event.summary}`;
    default:
      return "";
  }
}

function stringifyForPrompt(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 20) return text.slice(0, maxChars);
  const marker = "\n[... omitted for context recovery ...]\n";
  const head = Math.ceil((maxChars - marker.length) * 0.6);
  const tail = Math.floor((maxChars - marker.length) * 0.4);
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}
