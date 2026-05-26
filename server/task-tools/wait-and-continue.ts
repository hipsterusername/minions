/**
 * wait_and_continue tool — Pause execution then auto-resume.
 */

import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import type { TaskToolContext } from "./types.ts";

export function createWaitAndContinueToolDef(ctx: TaskToolContext): NormalizedToolDef {
  return {
    name: "wait_and_continue",
    description:
      'Pause execution for a specified duration, then the system will automatically resume your session with a "Continue" message. Use this when you need to wait for external processes (builds, deploys, tests) or to periodically check on long-running minion tasks. Maximum wait: 30 minutes.',
    inputSchema: z.object({
      duration_seconds: z
        .number()
        .min(5)
        .max(1800)
        .describe("How long to wait in seconds (5–1800)"),
      reason: z
        .string()
        .describe("Why you are waiting (shown to the user in the UI)"),
    }),
    handler: async (input: unknown) => {
      const args = input as { duration_seconds: number; reason: string };
      const durationMs = args.duration_seconds * 1000;
      const scheduledAt = Date.now();
      const timerId = ctx.scheduleWaitContinue(durationMs, args.reason);

      // Record the pending wait on the task state
      ctx.taskState.pendingWait = {
        durationMs,
        reason: args.reason,
        scheduledAt,
        timerId: timerId ?? null,
      };

      // Broadcast so the frontend can show the countdown immediately
      ctx.bus.emitToSession(ctx.leaderSessionKey, {
        type: "wait_state",
        sessionKey: ctx.leaderSessionKey,
        action: "started",
        durationMs,
        reason: args.reason,
        scheduledAt,
      });

      ctx.onStateChange?.(ctx.taskState);

      const mins = Math.floor(args.duration_seconds / 60);
      const secs = args.duration_seconds % 60;
      const display = mins > 0
        ? `${mins}m ${secs > 0 ? `${secs}s` : ""}`
        : `${secs}s`;

      return {
        content: [
          {
            type: "text" as const,
            text: `Waiting ${display}. Reason: ${args.reason}. The session will automatically resume with "Continue" after the wait period.`,
          },
        ],
      };
    },
  };
}
