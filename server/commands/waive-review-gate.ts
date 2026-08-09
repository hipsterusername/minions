import { waiveLatestWorkPacketGate } from "../system-model/store.ts";
import { getSessionOrError, sendControlError, sendControlResponse } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const waiveReviewGate: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  if (!cmd.gateId || !cmd.reason) {
    sendControlError(ws, "waive_review_gate", cmd.sessionKey!, cmd.requestId, "gateId and reason required");
    return;
  }
  const projectPath = host.worktree?.projectPath ?? host.cwd;
  const packet = waiveLatestWorkPacketGate(projectPath, host.id, cmd.gateId, cmd.reason);
  if (!packet) {
    sendControlError(ws, "waive_review_gate", cmd.sessionKey!, cmd.requestId, "No work packet for this session");
    return;
  }
  sendControlResponse(ws, "waive_review_gate", cmd.sessionKey!, cmd.requestId, {
    packet,
    gateId: cmd.gateId,
  });
};
