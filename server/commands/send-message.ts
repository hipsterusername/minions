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
import { persistTaskState } from "../session-persist.ts";
import { dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { serverLogger } from "../logging.ts";
import { isLeaderPromptCustomizationEnvelope } from "../../shared/leader-prompt.ts";

const log = serverLogger.child("send-message");

function projectPathForNewWorktree(cwd: string): string {
  const parent = dirname(cwd);
  return basename(parent) === ".canvas-worktrees" ? dirname(parent) : cwd;
}

export const sendMessage: CommandHandler = async (ctx, cmd, ws) => {
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
  if (host.role === "leader" && cmd.systemPrompt !== undefined
    && cmd.systemPrompt.trimStart().startsWith("{")
    && !isLeaderPromptCustomizationEnvelope(cmd.systemPrompt)) {
    unicastToSession(ws, cmd.sessionKey, {
      type: "error",
      message: "Leader systemPrompt contains a malformed customization envelope",
    });
    return;
  }
  if (host.workItemId) {
    const service = ctx.workItems;
    try {
      const detail = await service?.get(host.workItemId);
      const item = detail?.workItem;
      if (!service || !item) throw new Error("Canonical work item is unavailable");
      const mutation = {
        requestId: randomUUID(), workItemId: item.id, prompt: cmd.prompt,
        expectedLifecycleRevision: item.lifecycle.lifecycleRevision,
        expectedCurrentRunKey: item.currentRunKey,
      };
      await service.continue({ ...mutation,
        ...(cmd.displayPrompt ? { displayPrompt: cmd.displayPrompt } : {}),
        ...(cmd.model ? { model: cmd.model } : {}),
        ...(cmd.systemPrompt
          ? { systemPrompt: host.role === "leader" ? cmd.systemPrompt.trim() : cmd.systemPrompt }
          : {}),
        ...(cmd.thinkingConfig ? { thinkingConfig: cmd.thinkingConfig } : {}),
        ...(cmd.skillIds ? { skillIds: cmd.skillIds } : {}),
        ...(cmd.attachments ? { attachments: cmd.attachments } : {}),
      });
    } catch (error) {
      unicastToSession(ws, cmd.sessionKey, {
        type: "session_error", sessionKey: cmd.sessionKey,
        code: "WORK_ITEM_COMMAND_REQUIRED",
        error: error instanceof Error ? error.message : "Canonical work-item continuation failed",
        workItemId: host.workItemId, runKey: host.runKey,
        guidance: "Wait for the canonical work-item snapshot, then retry.",
        suggestedCommands: ["continue_work_item"], timestamp: Date.now(),
      });
    }
    return;
  }

  let prompt = cmd.prompt;
  if (host.taskState?.approval?.requested) {
    host.taskState.approval = null;
    persistTaskState(host.id, host.taskState);
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
  const turnSystemPrompt = host.role === "leader"
    ? cmd.systemPrompt?.trim() || undefined
    : cmd.systemPrompt;

  const resumeLeader = (cwd: string): void => {
    // Mid-thread harness switching is intentionally not supported. Even if
    // `cmd.harness` is present, we route through the host's existing
    // `harnessName` so a Claude conversation cannot silently flip into Codex
    // (or vice versa) on a follow-up turn.
    ctx.registry.start({
      sessionKey: cmd.sessionKey!,
      // The external legacy follow-up path deliberately retains new-run
      // behavior; internal replies are annotated separately.
      invocationKind: "new_run",
      prompt,
      ...(cmd.displayPrompt ? { displayPrompt: cmd.displayPrompt } : {}),
      cwd,
      resumeId: host.sessionId ?? undefined,
      // Leader customization is prefix-only. Non-leader roles retain their
      // existing customPrompt behavior unchanged.
      systemPrompt: turnSystemPrompt,
      role: host.role,
      thinkingConfig: turnThinking,
      harness: host.harnessName,
      sandboxPolicy: host.sandboxPolicy?.requested,
      ...(attachments ? { attachments } : {}),
    });
  };

  const needsNewWorktree =
    host.role === "leader" &&
    host.worktreeIsolation &&
    !host.worktree;

  if (needsNewWorktree) {
    createWorktree(projectPathForNewWorktree(host.cwd), cmd.sessionKey)
      .then((worktreeInfo) => {
        host.worktree = worktreeInfo;
        host.cwd = worktreeInfo.path;
        host.persist();
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
        log.error("follow_up_worktree_create_failed", {
          sessionKey: cmd.sessionKey,
          error: err,
        });
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
