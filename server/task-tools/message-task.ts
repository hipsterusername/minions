/**
 * message_task tool — Inject a steering message into a live minion session.
 *
 * Unlike cancel_task this does NOT change the task's status; it delivers a
 * new user turn to the running minion so the leader can redirect or answer it
 * without a kill + respawn. If the session is not live (ended, or never
 * delegated), the tool returns an error naming the actual status so the leader
 * can decide whether to retry or cancel.
 */

import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import { errorResult, textResult } from "../harness/tool-result.ts";
import type { TaskToolContext } from "./types.ts";
import { applyLifecycleEvent } from "../task-lifecycle.ts";

const messageTaskInputSchema = z.object({
  taskId: z.string().describe("The task ID whose minion should receive the message"),
  message: z
    .string()
    .describe("Steering message delivered to the minion as a new user turn"),
});

export function createMessageTaskToolDef(ctx: TaskToolContext): NormalizedToolDef {
  return {
    name: "message_task",
    description:
      "Send a steering message to a delegated task's live minion session as a new user turn. Does not change task status. Use to redirect a drifting minion or answer a blocked one without respawning. Fails if the session is not live.",
    inputSchema: messageTaskInputSchema,
    handler: async (input: unknown) => {
      const args = messageTaskInputSchema.parse(input);
      const { taskId, message } = args;

      const record = ctx.taskState.tasks.get(taskId);

      if (!record) {
        return errorResult(
          `Task ${taskId} does not exist. Nothing to message.`,
        );
      }

      if (!record.minionSessionKey) {
        return errorResult(
          `Task ${taskId} has no minion session (status: ${record.status}). ` +
            `Assign it with assign_task before messaging.`,
        );
      }

      if (!ctx.messageSession) {
        return errorResult(
          "Messaging is not available in this session context.",
        );
      }

      const outcome = ctx.messageSession(record.minionSessionKey, message);

      if (!outcome.delivered) {
        const status = outcome.status ?? "not found";
        const reason =
          outcome.status === "running"
            ? `is still finishing its turn (status: running). ` +
              `Retry once it is idle, or cancel_task and re-assign.`
            : `is not live (status: ${status}). ` +
              `Retry once it is idle, or cancel_task and re-assign.`;
        return errorResult(
          `Task ${taskId}'s minion session ${reason}`,
        );
      }

      // Answering a blocked minion un-blocks it: the resume turn moves the task
      // back to running. Other statuses are left untouched.
      if (record.status === "blocked") {
        applyLifecycleEvent({
          bus: ctx.bus,
          leaderSessionKey: ctx.leaderSessionKey,
          taskState: ctx.taskState,
          taskId,
          event: { type: "session_running" },
          onStateChange: ctx.onStateChange,
        });
      }

      return textResult(`Message delivered to task ${taskId}.`);
    },
  };
}
