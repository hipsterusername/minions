/**
 * create_session — open a new Claude session and register it.
 *
 * Validates cwd against the path-guard, honours MAX_SESSIONS, and hands the
 * heavy lifting (SDK query open, worktree provisioning, event fan-out) off
 * to `SessionRegistry.start()`. Replies with a `session_created` envelope.
 *
 * Rejection routing: when the client supplies a `sessionKey` the rejection
 * goes out as a session-scoped `session_error` so the LeaderNode reducer
 * (which only wires up `session_error` → `status: "error"`) actually
 * surfaces it to the user. Without this the UI sticks at `creating`
 * forever because `unicastGlobal({type: "error", ...})` is dropped by the
 * session-stream reducer.
 */

import { unicastGlobal, unicastToSession } from "../bus.ts";
import { validateSessionCwd } from "../path-guard.ts";
import { isValidThinkingConfig, type ThinkingConfig } from "../session-host.ts";
import { registeredHarnessNames } from "../harness/index.ts";
import { sanitizeAttachments } from "./attachment-sanitize.ts";
import type { CommandContext, CommandHandler } from "./types.ts";
import type { WebSocket } from "ws";

/** Send a rejection back to the right scope based on whether we have a sessionKey. */
function rejectCreate(
  ws: WebSocket,
  sessionKey: string | undefined,
  message: string,
): void {
  if (sessionKey) {
    unicastToSession(ws, sessionKey, {
      type: "session_error",
      sessionKey,
      error: message,
      timestamp: Date.now(),
    });
    return;
  }
  unicastGlobal(ws, { type: "error", message });
}

export const createSession: CommandHandler = (
  ctx: CommandContext,
  cmd,
  ws,
) => {
  const key = cmd.sessionKey ?? ctx.generateKey();

  // create_session is frequently sent from UI effects. Treat a repeated key
  // as an idempotent acknowledgement instead of re-entering SessionHost.start(),
  // which would open another SDK query for the same logical session.
  if (cmd.sessionKey && ctx.registry.get(key)) {
    unicastToSession(ws, key, { type: "session_created", sessionKey: key });
    return;
  }

  if (ctx.registry.activeCount() >= ctx.maxSessions) {
    rejectCreate(
      ws,
      cmd.sessionKey,
      `Maximum session limit (${ctx.maxSessions}) reached. Remove unused sessions first.`,
    );
    return;
  }
  const rawCwd = cmd.cwd ?? process.cwd();
  const cwd = validateSessionCwd(rawCwd);
  if (!cwd) {
    rejectCreate(ws, key, "Invalid cwd: must be under home directory");
    return;
  }
  const prompt = cmd.prompt ?? "Hello";
  const initialThinking: ThinkingConfig | null = isValidThinkingConfig(
    cmd.thinkingConfig,
  )
    ? cmd.thinkingConfig
    : null;
  const attachments = sanitizeAttachments(cmd.attachments);
  // Validate harness up front so an unknown name surfaces as a session-scoped
  // session_error rather than crashing the SDK loop later. Empty / undefined
  // means "use the SessionHost default" (claude).
  if (cmd.harness !== undefined && cmd.harness !== "") {
    const known = registeredHarnessNames();
    if (!known.includes(cmd.harness)) {
      rejectCreate(
        ws,
        key,
        `Unknown harness "${cmd.harness}". Registered harnesses: ${
          known.join(", ") || "(none registered)"
        }.`,
      );
      return;
    }
  }
  ctx.registry.start({
    sessionKey: key,
    prompt,
    cwd,
    systemPrompt: cmd.systemPrompt,
    role: cmd.role,
    worktreeIsolation: cmd.worktreeIsolation,
    initialModel: cmd.model ?? null,
    thinkingConfig: initialThinking,
    ...(attachments ? { attachments } : {}),
    ...(cmd.harness ? { harness: cmd.harness } : {}),
    ...(cmd.permissionMode ? { permissionMode: cmd.permissionMode } : {}),
  });
  ctx.bus.emitGlobal({ type: "session_list", sessions: ctx.registry.snapshot() });
  unicastToSession(ws, key, { type: "session_created", sessionKey: key });
};
