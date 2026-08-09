import { openProjectDb } from "../project-store.ts";
import { workPacketSchema } from "../../shared/system-model/index.ts";
import { getSessionOrError, sendControlError, sendControlResponse } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const getWorkPackets: CommandHandler = (ctx, cmd, ws) => {
  const host = cmd.sessionKey ? getSessionOrError(ctx.registry, cmd.sessionKey, ws) : null;
  if (cmd.sessionKey && !host) return;
  const projectPath = cmd.projectPath ?? host?.worktree?.projectPath ?? host?.cwd;
  if (!projectPath) {
    sendControlError(ws, "get_work_packets", cmd.sessionKey ?? "global", cmd.requestId, "sessionKey or projectPath required");
    return;
  }

  const db = openProjectDb(projectPath);
  const rows = cmd.workPacketId
    ? db.prepare(
        `SELECT packet_json, context_pack, updated_at
         FROM work_packets
         WHERE id = ?`,
      ).all(cmd.workPacketId)
    : db.prepare(
        `SELECT packet_json, context_pack, updated_at
         FROM work_packets
         WHERE (? IS NULL OR leader_session_key = ?)
         ORDER BY updated_at DESC, created_at DESC`,
      ).all(cmd.sessionKey ?? null, cmd.sessionKey ?? null);

  const packets = (rows as Array<{ packet_json: string; context_pack: string; updated_at: number }>).map((row) => ({
    packet: workPacketSchema.parse(JSON.parse(row.packet_json)),
    contextPack: row.context_pack,
    updatedAt: row.updated_at,
  }));

  sendControlResponse(ws, "get_work_packets", cmd.sessionKey ?? "global", cmd.requestId, {
    projectPath,
    packets,
  });
};
