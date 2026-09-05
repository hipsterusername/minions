import type { NormalizedEvent } from "../shared/normalized-event.ts";
import type { Bus } from "./bus.ts";
import type { SessionHost, StartSessionOptions } from "./session-host.ts";
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
  validateCheckpointBoundary,
} from "./task-tools/checkpoint-session.ts";
import { readSettings } from "./project-store.ts";
import { activeWorktreeOperation } from "./commands/worktree-operation-lock.ts";
import {
  checkpointStartOptions,
  compileContextCheckpoint,
  renderCheckpointPrompt,
} from "./context-checkpoint.ts";

const MAX_HANDOFF_CHARS = 4_000;
const RECOMMEND_REMINDER =
  "System reminder: Context is above the proactive checkpoint recommendation threshold. Call `checkpoint_session` at the next safe boundary. Include the objective, user constraints and corrections, decisions, completed work, exact artifact paths, verification evidence, unresolved risks, and the next concrete action.";

export interface ProactiveCompactionState {
  setting: ProactiveCompactionSetting;
  /** True once `setting` has been resolved from project settings (or set explicitly). */
  settingResolved: boolean;
  advisor: CompactionAdvisorState;
  recommended: CompactionAdvice | null;
  forcePending: CompactionAdvice | null;
  handoffText: string;
  handoffSawDelta: boolean;
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
    handoffSawDelta: false,
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
  if (advice.action === "force" && (state.setting === "recommend" || state.setting === "auto")) {
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
    // A complete assistant text supersedes any deltas captured for the same
    // block, preventing the durable handoff from being duplicated.
    host.proactiveCompaction.handoffText = truncate(event.text, MAX_HANDOFF_CHARS);
  } else if (event.kind === "text_delta" && !event.parentId) {
    host.proactiveCompaction.handoffSawDelta = true;
    appendHandoff(host, event.text);
  }
}

export function buildPendingCompactionStartOptions(
  host: SessionHost,
  opts: StartSessionOptions,
): StartSessionOptions | null {
  if (host.role !== "leader") return null;
  if ((isCheckpointRequested(host.id) || host.proactiveCompaction.forcePending) && !isSafeToAutoCompact(host)) return null;
  const handoff = consumeCheckpointHandoff(host.id) ?? autoHandoff(host);
  const manual = host.proactiveCompaction.handoffText.trim();
  const forced = host.proactiveCompaction.forcePending;
  if (!manual && !forced && !handoff) return null;
  const priorSessionId = host.sessionId;
  if (priorSessionId) host.proactiveCompaction.oldSessionIds.push(priorSessionId);
  const checkpoint = compileContextCheckpoint(host, {
    trigger: "proactive",
    originalPrompt: opts.continuitySource === "system" ? "" : opts.prompt,
    modelHandoff: manual || handoff || "Automatic checkpoint at idle boundary.",
    usage: forced,
  });
  host.contextCheckpoint = checkpoint;
  host.proactiveCompaction.forcePending = null;
  host.proactiveCompaction.handoffText = "";
  host.proactiveCompaction.handoffSawDelta = false;
  return checkpointStartOptions(checkpoint, opts);
}

export function emitSessionCompacted(
  host: SessionHost,
  deps: { bus: Bus },
  oldSessionId: string | null,
  advice: CompactionAdvice | null,
): void {
  try {
    const event = {
      type: "session_compacted",
      sessionKey: host.id,
      checkpointId: host.contextCheckpoint?.checkpointId,
      trigger: host.contextCheckpoint?.trigger,
      oldSessionId,
      newSessionId: host.sessionId,
      contextTokensBefore: advice?.contextTokens,
      contextWindowTokens: advice?.contextWindowTokens,
      ratioBefore: advice?.ratio,
      timestamp: Date.now(),
    };
    host.bufferEvent(event);
    deps.bus.emitToSession(host.id, event);
  } catch {
    // The checkpoint transaction is committed once the provider initializes;
    // a faulty observer must not roll a healthy fresh thread back to error.
  }
}

export function buildProactiveCompactionSeed(
  host: SessionHost,
  handoff: string,
): string {
  const checkpoint = compileContextCheckpoint(host, {
    trigger: "proactive",
    originalPrompt: host.taskName ?? "Continue the active objective.",
    modelHandoff: handoff,
    persist: false,
  });
  return renderCheckpointPrompt(checkpoint);
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
  if (activeWorktreeOperation(host)) return false;
  if (!host.taskState) return true;
  return validateCheckpointBoundary({
    taskState: host.taskState,
    renderComponents: host.renderState?.components,
  }).safe;
}

function truncate(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, maxChars).join("")}\n[... truncated for proactive compaction ...]`;
}
