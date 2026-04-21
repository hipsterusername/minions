/**
 * create_session — open a new Claude session and register it.
 *
 * Validates cwd against the path-guard, honours MAX_SESSIONS, and hands the
 * heavy lifting (SDK query open, worktree provisioning, event fan-out) off
 * to `SessionRegistry.start()`. Replies with a `session_created` envelope.
 */

import { unicastGlobal, unicastToSession } from "../bus.ts";
import { validateSessionCwd } from "../path-guard.ts";
import { isValidThinkingConfig, type ThinkingConfig } from "../session-host.ts";
import type { CommandHandler } from "./types.ts";

export const createSession: CommandHandler = (ctx, cmd, ws) => {
  if (ctx.registry.size >= ctx.maxSessions) {
    unicastGlobal(ws, {
      type: "error",
      message: `Maximum session limit (${ctx.maxSessions}) reached. Remove unused sessions first.`,
    });
    return;
  }
  const key = cmd.sessionKey ?? ctx.generateKey();
  const rawCwd = cmd.cwd ?? process.cwd();
  const cwd = validateSessionCwd(rawCwd);
  if (!cwd) {
    unicastGlobal(ws, {
      type: "error",
      message: "Invalid cwd: must be under home directory",
    });
    return;
  }
  const prompt = cmd.prompt ?? "Hello";
  const initialThinking: ThinkingConfig | null = isValidThinkingConfig(
    cmd.thinkingConfig,
  )
    ? cmd.thinkingConfig
    : null;
  ctx.registry.start({
    sessionKey: key,
    prompt,
    cwd,
    systemPrompt: cmd.systemPrompt,
    role: cmd.role,
    worktreeIsolation: cmd.worktreeIsolation,
    initialModel: cmd.model ?? null,
    thinkingConfig: initialThinking,
  });
  unicastToSession(ws, key, { type: "session_created", sessionKey: key });
};
