/**
 * send_message — continue a conversation or kick off a follow-up turn.
 *
 * Two subtleties:
 *   1. If the session is awaiting approval and the user sends a message
 *      instead of clicking "Approve", the prompt is treated as a change
 *      request and wrapped with explanatory context for the agent.
 *   2. If the session has worktree isolation enabled but no live worktree
 *      (post-merge or post-discard), a fresh worktree is created before the
 *      agent resumes so the next round of changes stays isolated.
 */

import { unicastGlobal, unicastToSession } from "../bus.ts";
import { createWorktree } from "../worktree.ts";
import { isValidThinkingConfig, type ThinkingConfig } from "../session-host.ts";
import { sanitizeAttachments } from "./attachment-sanitize.ts";
import { errToMessage } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const sendMessage: CommandHandler = (ctx, cmd, ws) => {
  if (!cmd.sessionKey || !cmd.prompt) {
    unicastGlobal(ws, {
      type: "error",
      message: "sessionKey and prompt required",
    });
    return;
  }
  const host = ctx.registry.get(cmd.sessionKey);
  if (!host) {
    unicastToSession(ws, cmd.sessionKey, {
      type: "error",
      message: `Session ${cmd.sessionKey} not found`,
    });
    return;
  }

  // ── Approval → change-request conversion ─────────────
  let prompt = cmd.prompt;
  if (host.taskState?.approval?.requested) {
    host.taskState.approval = null;
    prompt = `[The user has reviewed your changes and is requesting modifications instead of approving. Their feedback follows.]\n\n${prompt}`;
    ctx.bus.emitToSession(cmd.sessionKey, {
      type: "approval_resolved",
      sessionKey: cmd.sessionKey,
      action: "changes_requested",
      timestamp: Date.now(),
    });
  }

  // Refresh thinking config from the latest payload so effort/display
  // changes are respected on the next turn.
  const turnThinking: ThinkingConfig | null = isValidThinkingConfig(
    cmd.thinkingConfig,
  )
    ? cmd.thinkingConfig
    : host.thinkingConfig;

  // Follow-up turns may also carry image attachments (e.g. the user
  // connects a new image node and sends another prompt mid-conversation).
  const attachments = sanitizeAttachments(cmd.attachments);

  const resumeLeader = (cwd: string): void => {
    ctx.registry.start({
      sessionKey: cmd.sessionKey!,
      prompt,
      cwd,
      resumeId: host.sessionId ?? undefined,
      systemPrompt: cmd.systemPrompt ?? undefined,
      role: host.role,
      thinkingConfig: turnThinking,
      ...(attachments ? { attachments } : {}),
    });
  };

  // ── Start a fresh approval cycle when the previous worktree is gone ──
  const needsNewWorktree =
    host.role === "leader" &&
    host.worktreeIsolation &&
    !host.worktree;

  if (needsNewWorktree) {
    createWorktree(host.cwd, cmd.sessionKey)
      .then((worktreeInfo) => {
        host.worktree = worktreeInfo;
        host.cwd = worktreeInfo.path;
        ctx.bus.emitToSession(cmd.sessionKey!, {
          type: "worktree_created",
          sessionKey: cmd.sessionKey,
          worktreePath: worktreeInfo.path,
          branch: worktreeInfo.branch,
        });
        resumeLeader(worktreeInfo.path);
      })
      .catch((err: unknown) => {
        const errMsg = errToMessage(err);
        console.error(
          `[worktree] Failed to create follow-up worktree for ${cmd.sessionKey}: ${errMsg}`,
        );
        ctx.bus.emitToSession(cmd.sessionKey!, {
          type: "worktree_failed",
          sessionKey: cmd.sessionKey,
          error: `Follow-up worktree creation failed: ${errMsg}`,
        });
      });
  } else {
    resumeLeader(host.cwd);
  }
};
