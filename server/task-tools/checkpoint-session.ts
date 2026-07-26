import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import { textResult } from "../harness/tool-result.ts";
import type { TaskToolContext } from "./types.ts";
import {
  findUnansweredForms,
  type RenderComponent,
} from "../../shared/render-dsl.ts";

const checkpointInputSchema = z.object({});
const pendingHandoff = new Map<string, string>();

export function consumeCheckpointHandoff(sessionKey: string): string | null {
  if (!pendingHandoff.has(sessionKey)) return null;
  const value = pendingHandoff.get(sessionKey) ?? "";
  pendingHandoff.delete(sessionKey);
  return value;
}

export function isCheckpointRequested(sessionKey: string): boolean {
  return pendingHandoff.has(sessionKey);
}

export function resetCheckpointSessionStateForTest(): void {
  pendingHandoff.clear();
}

export function validateCheckpointBoundary(ctx: {
  taskState: TaskToolContext["taskState"];
  renderComponents?: RenderComponent[];
}): { safe: true } | { safe: false; reason: string } {
  if (ctx.taskState.approval?.requested) {
    return { safe: false, reason: "approval is pending" };
  }
  if (ctx.taskState.pendingWait?.wakeOn === "any_terminal") {
    return { safe: false, reason: "any-terminal child steering wait is pending" };
  }
  if (
    ctx.renderComponents &&
    findUnansweredForms(ctx.renderComponents).length > 0
  ) {
    return { safe: false, reason: "form input is pending" };
  }
  return { safe: true };
}

export function createCheckpointSessionToolDef(
  ctx: TaskToolContext,
): NormalizedToolDef {
  return {
    name: "checkpoint_session",
    description:
      "Request a proactive session checkpoint. Use at a safe boundary; the next assistant message must be a compact handoff with goal, decisions, dead ends, open threads, and next steps.",
    inputSchema: checkpointInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    handler: async (input: unknown) => {
      checkpointInputSchema.parse(input);
      if (pendingHandoff.has(ctx.leaderSessionKey)) {
        return textResult("checkpoint already requested; emit the handoff next.");
      }
      const boundary = validateCheckpointBoundary({
        taskState: ctx.taskState,
        renderComponents: ctx.getRenderComponents?.(),
      });
      if (!boundary.safe) return textResult(`deferred: ${boundary.reason}`);
      pendingHandoff.set(ctx.leaderSessionKey, "");
      return textResult(
        "Emit one structured handoff next, under 4000 characters: goal; decisions and rationale; dead ends; open threads; next steps. The server will continue in a fresh thread after this turn.",
      );
    },
  };
}
