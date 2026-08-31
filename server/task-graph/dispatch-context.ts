import type { GraphRevisionInput,TaskNode } from "../../shared/task-graph-contracts.ts";
import type { TaskGraphService } from "./service.ts";

type Row=Record<string,unknown>;

export function humanGuidanceForNode(
  service:TaskGraphService,
  runId:string,
  nodeId:string,
):string[] {
  const rows=service.options.db.prepare(`SELECT record_json FROM task_human_inputs
    WHERE run_id=? AND node_id=? ORDER BY created_at,id`).all(runId,nodeId) as Row[];
  return rows.map(row=>JSON.parse(String(row.record_json)) as {value?:unknown})
    .map(record=>record.value).filter((value):value is string=>typeof value==="string");
}

export function affinityResumeForNode(
  service:TaskGraphService,
  runId:string,
  spec:GraphRevisionInput,
  node:TaskNode,
):{resumeId:string;harness:string;model?:string}|null {
  const affinity=node.sessionAffinity;
  if (!affinity||affinity.sequence===0) return null;
  const predecessors=spec.nodes.filter(candidate=>candidate.sessionAffinity?.key===affinity.key
    &&candidate.sessionAffinity.sequence<affinity.sequence)
    .sort((left,right)=>right.sessionAffinity!.sequence-left.sessionAffinity!.sequence);
  for (const predecessor of predecessors) {
    const row=service.options.db.prepare(`SELECT session.session_id,session.harness_name,session.model
      FROM task_node_attempts attempt JOIN sessions session
        ON session.session_key=attempt.session_run_key
      WHERE attempt.run_id=? AND attempt.node_id=? AND attempt.runtime='terminal'
      AND attempt.outcome='succeeded' AND session.session_id IS NOT NULL
      ORDER BY attempt.attempt_number DESC LIMIT 1`).get(runId,predecessor.id) as Row|undefined;
    if (!row?.session_id||!row.harness_name) continue;
    return {resumeId:String(row.session_id),harness:String(row.harness_name),
      ...(typeof row.model==="string"&&row.model?{model:row.model}:{})};
  }
  return null;
}
