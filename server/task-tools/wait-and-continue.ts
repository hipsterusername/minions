/**
 * wait_and_continue tool — Pause execution then auto-resume.
 */

import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import { textResult } from "../harness/tool-result.ts";
import type { TaskToolContext } from "./types.ts";
import { isTerminalTaskStatus } from "../task-lifecycle.ts";

const waitAndContinueInputSchema = z.object({
  duration_seconds: z
    .number()
    .min(5)
    .max(1800)
    .describe("How long to wait in seconds (5–1800)"),
  reason: z
    .string()
    .describe("Why you are waiting (shown to the user in the UI)"),
  wake_on: z
    .enum(["any_terminal", "all_terminal"])
    .optional()
    .describe(
      '"any_terminal" — resume as soon as ANY delegated task reaches a terminal state (use to pipeline review/integration); "all_terminal" — resume only when all are terminal (default).',
    ),
});

export function createWaitAndContinueToolDef(ctx: TaskToolContext): NormalizedToolDef {
  return {
    name: "wait_and_continue",
    description:
      'Pause execution for a specified duration, then the system will automatically resume your session with a "Continue" message. Use this when you need to wait for external processes (builds, deploys, tests) or to periodically check on long-running minion tasks. Maximum wait: 30 minutes.',
    inputSchema: waitAndContinueInputSchema,
    handler: async (input: unknown) => {
      const args = waitAndContinueInputSchema.parse(input);
      const durationMs = args.duration_seconds * 1000;
      const scheduledAt = Date.now();
      const timerId = ctx.scheduleWaitContinue(durationMs, args.reason);

      // Record the pending wait on the task state
      ctx.taskState.pendingWait = {
        durationMs,
        reason: args.reason,
        scheduledAt,
        timerId: timerId ?? null,
        wakeOn: args.wake_on,
        taskIds: Array.from(ctx.taskState.tasks.values())
          .filter((task) => task.executor === "minion" && !isTerminalTaskStatus(task.status))
          .map((task) => task.taskId)
          .sort(),
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

      // The duration display is new information (server-side formatting and
      // clamping); the reason is the model's own input, so it is not echoed.
      // Only mention wake policy when it differs from the default.
      const policyNote =
        args.wake_on === "any_terminal"
          ? " Resumes on any terminal child task."
          : "";
      return textResult(
        `Waiting ${display.trim()}; session auto-resumes with "Continue".${policyNote}`,
      );
    },
  };
}
