import { unicastGlobal, type BusPayload } from "../bus.ts";
import { worktreeLineageSnapshotSchema } from "../../shared/worktree-integration.ts";
import type { CommandHandler } from "./types.ts";

/**
 * Return every worktree lineage the integration service can see so the
 * frontend can render a "big picture" list and let a leader map a work item
 * onto an existing lineage. Each snapshot carries its own `projectId`, so the
 * client scopes/groups the list per project.
 *
 * Response envelope (exact shape mirrored by the client):
 *   { type: "worktree_lineages_list", requestId, lineages: WorktreeLineageSnapshot[] }
 * On failure the same envelope is sent with `lineages: []` and an `error` string.
 */
export const listWorktreeLineages: CommandHandler = async (ctx, cmd, ws) => {
  const requestId = cmd.requestId ?? null;
  const service = ctx.worktreeIntegrations;
  if (!service) {
    unicastGlobal(ws, { type: "worktree_lineages_list", requestId, lineages: [],
      error: "Integration service unavailable" } satisfies BusPayload);
    return;
  }
  try {
    const raw = await service.listLineages();
    const lineages = raw.map((entry) => worktreeLineageSnapshotSchema.parse(entry));
    unicastGlobal(ws, { type: "worktree_lineages_list", requestId, lineages } satisfies BusPayload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list worktree lineages";
    unicastGlobal(ws, { type: "worktree_lineages_list", requestId, lineages: [],
      error: message } satisfies BusPayload);
  }
};
