import { unicastGlobal, unicastToLineage, unicastToWorkItem, type BusPayload } from "../bus.ts";
import { worktreeLineageSnapshotSchema } from "../../shared/worktree-integration.ts";
import { WorktreeIntegrationServiceError } from "../worktree-integration-service.ts";
import type { CommandHandler } from "./types.ts";

export const worktreeIntegrationCommand: CommandHandler = async (ctx, cmd, ws) => {
  const service = ctx.worktreeIntegrations;
  const send = (payload: BusPayload) => cmd.lineageId
    ? unicastToLineage(ws, cmd.lineageId, payload)
    : cmd.workItemId ? unicastToWorkItem(ws, cmd.workItemId, payload) : unicastGlobal(ws, payload);
  if (!service) { send({ type: "worktree_integration_response", command: cmd.type,
    requestId: cmd.requestId ?? null, success: false, code: "internal", error: "Integration service unavailable" }); return; }
  try {
    let raw: unknown;
    switch (cmd.type) {
    case "create_worktree_lineage": raw = await service.createLineage({ requestId: cmd.requestId!,
      workItemId: cmd.workItemId!, ...(cmd.targetBranch ? { targetBranch: cmd.targetBranch } : {}) }); break;
    case "join_worktree_lineage": raw = await service.joinLineage({ requestId: cmd.requestId!,
      workItemId: cmd.workItemId!, lineageId: cmd.lineageId!,
      expectedRevision: cmd.expectedIntegrationRevision!, actor: cmd.actor! }); break;
    case "review_worktree_contribution": raw = await service.reviewContribution({ requestId: cmd.requestId!,
      contributionId: cmd.contributionId!, expectedRevision: cmd.expectedIntegrationRevision!,
      decision: cmd.decision!, actor: cmd.actor!, summary: cmd.summary! }); break;
    case "enqueue_worktree_contribution": raw = await service.enqueueContribution({ requestId: cmd.requestId!,
      contributionId: cmd.contributionId!, expectedRevision: cmd.expectedIntegrationRevision! }); break;
    case "retry_worktree_contribution": raw = await service.retryContribution({ requestId: cmd.requestId!,
      contributionId: cmd.contributionId!, expectedRevision: cmd.expectedIntegrationRevision! }); break;
    case "discard_worktree_contribution": raw = await service.discardContribution({ requestId: cmd.requestId!,
      contributionId: cmd.contributionId!, expectedRevision: cmd.expectedIntegrationRevision!,
      ...(cmd.reason ? { reason: cmd.reason } : {}) }); break;
    case "review_worktree_lineage": raw = await service.reviewFinal({ requestId: cmd.requestId!,
      lineageId: cmd.lineageId!, expectedRevision: cmd.expectedIntegrationRevision!,
      decision: cmd.decision!, actor: cmd.actor!, summary: cmd.summary! }); break;
    case "waive_worktree_integration_gate": raw = await service.waiveGate({ requestId: cmd.requestId!,
      scope: cmd.integrationScope!, lineageId: cmd.lineageId!,
      ...(cmd.contributionId ? { contributionId: cmd.contributionId } : {}),
      expectedRevision: cmd.expectedIntegrationRevision!, gateId: cmd.gateId!,
      actor: cmd.actor!, reason: cmd.reason! }); break;
    case "resolve_worktree_conflict": raw = await service.resolveConflict({ requestId: cmd.requestId!,
      contributionId: cmd.contributionId!, queueId: cmd.queueId!, strategy: cmd.strategy!,
      expectedRevision: cmd.expectedIntegrationRevision!, actor: cmd.actor!, reason: cmd.reason! }); break;
    case "promote_worktree_lineage": raw = await service.promote({ requestId: cmd.requestId!,
      lineageId: cmd.lineageId!, expectedRevision: cmd.expectedIntegrationRevision! }); break;
    case "get_worktree_lineage_status": raw = await service.getStatus({
      ...(cmd.lineageId ? { lineageId: cmd.lineageId } : {}),
      ...(cmd.workItemId ? { workItemId: cmd.workItemId } : {}),
      ...(cmd.runKey ? { runKey: cmd.runKey } : {}) }); break;
    default: return;
    }
    const result = raw === null ? null : worktreeLineageSnapshotSchema.parse(raw);
    send({ type: "worktree_integration_response", command: cmd.type, requestId: cmd.requestId ?? null,
      success: true, result });
  } catch (error) {
    const typed = error instanceof WorktreeIntegrationServiceError ? error : null;
    send({ type: "worktree_integration_response", command: cmd.type, requestId: cmd.requestId ?? null,
      success: false, code: typed?.code ?? "internal", error: typed?.message ?? "Integration command failed",
      latest: typed?.latest ?? null });
  }
};
