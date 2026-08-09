/**
 * Context-window recovery helpers for SessionHost.
 *
 * Handles detecting context-window overflow errors and building a
 * compacted continuation prompt so the session can resume in a fresh
 * thread without losing task state.
 */

import type { NormalizedEvent } from "../shared/normalized-event.ts";
import type { SessionHost, StartSessionOptions } from "./session-host.ts";
import { checkpointStartOptions, compileContextCheckpoint } from "./context-checkpoint.ts";

// ── Constants ───────────────────────────────────────────────────────────────

const CONTEXT_WINDOW_PATTERNS = [
  /ran out of room in the model'?s context window/i,
  /context window/i,
  /context length/i,
  /maximum context/i,
  /too many tokens/i,
];


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
  const checkpoint = compileContextCheckpoint(host, {
    trigger: "context_recovery",
    originalPrompt: opts.prompt,
    recoveryCause: event.fullError ?? event.error ?? "context window exceeded",
  });
  host.contextCheckpoint = checkpoint;
  return checkpointStartOptions(checkpoint, opts);
}
