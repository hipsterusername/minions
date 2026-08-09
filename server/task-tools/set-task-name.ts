/**
 * set_task_name tool — Set the durable purpose label for the leader session.
 */

import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import { okResult } from "../harness/tool-result.ts";
import type { TaskToolContext } from "./types.ts";

const setTaskNameInputSchema = z.object({
  name: z.string()
    .trim()
    .min(1, "Session name cannot be empty")
    .max(72, "Session name must be 72 characters or fewer")
    .refine((value) => !/[\r\n]/.test(value), "Session name must be a single line")
    .describe("Durable 3-6 word label for the session's overall purpose"),
});

export function createSetTaskNameToolDef(ctx: TaskToolContext): NormalizedToolDef {
  return {
    name: "set_task_name",
    description:
      "Set a durable, purpose-clear display name for this leader session (3-6 words). Call once at the start, and rename only if the core objective materially changes.",
    inputSchema: setTaskNameInputSchema,
    handler: async (input: unknown) => {
      const args = setTaskNameInputSchema.parse(input);
      ctx.onTaskNameChange?.(args.name);
      ctx.bus.emitToSession(ctx.leaderSessionKey, {
        type: "session_task_name",
        sessionKey: ctx.leaderSessionKey,
        taskName: args.name,
      });
      // Terse ack — never echo the name the model just sent.
      return okResult();
    },
  };
}
