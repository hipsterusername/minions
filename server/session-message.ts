/**
 * Steering-message injection for live sessions (message_task plumbing).
 *
 * Resumes the target session with the message as its prompt. Only an idle
 * session is deliverable: `SessionHost.start()` early-returns while a turn is
 * in flight, so a running (mid-turn) session would drop the resume. Callers must
 * retry once the session is idle. Ended sessions (stopped/error/completed) are
 * reported as not delivered so the caller can surface a useful error. Extracted
 * from session-host-run.ts to keep that file under its architectural size budget.
 */

import { randomUUID } from "node:crypto";
import type { SessionHostDeps } from "./session-host.ts";

export function injectSessionMessage(
  deps: SessionHostDeps,
  sessionKey: string,
  message: string,
): { delivered: boolean; status: string | null } {
  const runtime = deps.getSessionRuntime?.(sessionKey);
  if (!runtime) return { delivered: false, status: null };
  if (runtime.status !== "idle") {
    return { delivered: false, status: runtime.status };
  }
  // Omit role so the resumed host keeps its own persisted value (start()
  // falls back to this.role when unset).
  if (runtime.workItemId && runtime.runKind === "child" && deps.continueWorkItemChild) {
    void deps.continueWorkItemChild({ workItemId: runtime.workItemId,
      runKey: runtime.runKey ?? sessionKey, prompt: message,
      requestId: `message:${sessionKey}:${randomUUID()}` });
    return { delivered: true, status: runtime.status };
  }
  deps.startChildSession({
    sessionKey,
    invocationKind: "resume_open_run",
    prompt: message,
    cwd: runtime.cwd,
    resumeId: runtime.sessionId ?? undefined,
    harness: runtime.harness,
  });
  return { delivered: true, status: runtime.status };
}
