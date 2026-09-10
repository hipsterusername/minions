import { emptySessionStreamState, type SessionStreamState } from "./session-stream.ts";
import type { LeaderData } from "./nodes/leader/types.ts";

export type CanvasPendingMessages = Partial<Pick<LeaderData, "messages" | "messageDelivery">>;

/** Chat state belongs to a run, even when its canvas node survives iterations. */
export function canvasRunStreamPatch(
  previousRunKey: string | null | undefined, nextRunKey: string | null,
  previous: CanvasPendingMessages = {},
): Partial<SessionStreamState> {
  if (!nextRunKey) return {};
  if (!previousRunKey || previousRunKey === nextRunKey) return { sessionKey: nextRunKey };
  // A run transition must not erase submissions still awaiting acceptance or
  // retry. Accepted history belongs to the old run and is cleared as before.
  const messages = (previous.messages ?? []).filter((message) => {
    const state = previous.messageDelivery?.[message.id]?.state;
    return message.role === "user" && (state === "sending" || state === "unconfirmed" || state === "failed");
  });
  return { ...emptySessionStreamState(nextRunKey), messages, status: "creating",
    contextDelivery: {}, historyHighWater: undefined };
}
