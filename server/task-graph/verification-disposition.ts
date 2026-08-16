import type { GraphRevisionInput } from "../../shared/task-graph-contracts.ts";
import type { TaskGraphService } from "./service.ts";

type Row=Record<string,unknown>;

export const MAX_AUTOMATIC_INCONCLUSIVE_VERIFICATIONS=2;

export function applyVerificationDisposition(service:TaskGraphService,request:Row,
  node:GraphRevisionInput["nodes"][number],result:"failed"|"inconclusive",at:number):void {
  const runId=String(request.run_id);
  const idempotencyKey=`verification-disposition:${String(request.id)}:${result}`;
  const status=service.options.db.transaction(()=>{
    if (service.options.db.prepare(`SELECT 1 FROM task_scheduler_events
      WHERE run_id=? AND idempotency_key=?`).get(runId,idempotencyKey)) return null;
    const graph=service.repo.snapshot(runId,0);
    if (!["active","quiescent","blocked"].includes(graph.run.status)) return null;
    const outgoing=graph.revision.edges.filter(edge=>edge.sourceNodeId===node.id && !edge.optional
      && edge.satisfactionPolicy!=="all_terminal");
    const mustFail=node.failurePolicy==="fail_graph"
      || graph.revision.terminalNodeIds.includes(node.id)
      || outgoing.some(edge=>edge.failurePolicy==="fail");
    const mustBlock=node.failurePolicy==="block_for_decision"
      || outgoing.some(edge=>edge.failurePolicy==="block");
    const nextStatus=mustFail?"failed":mustBlock?"blocked":null;
    if (!nextStatus) return null;
    const revision=service.repo.casRun(runId,graph.run.revision,{status:nextStatus},at);
    service.repo.appendEvent(runId,revision,"verification_disposition",String(request.id),
      idempotencyKey,{nodeId:node.id,producerAttemptId:request.producer_attempt_id,
        result,status:nextStatus},at);
    return nextStatus;
  }).immediate();
  if (status==="failed") service.evidence.drainTerminalOperations(String(request.run_id),at);
}
