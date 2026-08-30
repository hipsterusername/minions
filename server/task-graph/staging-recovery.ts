import type Database from "better-sqlite3";
import type {GraphRevisionInput} from "../../shared/task-graph-contracts.ts";
import {safeArtifactReference,type TaskGraphArtifactReference} from "./artifact-access.ts";
import {currentProducerArtifacts} from "./evidence.ts";
import type {TaskGraphRecoveryDraft} from "./node-prompt.ts";

type Row=Record<string,unknown>;

export function resolvedInputArtifacts(db:Database.Database,runId:string,
  spec:GraphRevisionInput,nodeId:string):TaskGraphArtifactReference[] {
  const inputs:TaskGraphArtifactReference[]=[];
  for (const edge of spec.edges.filter(candidate=>candidate.targetNodeId===nodeId
    && (candidate.kind==="artifact" || candidate.kind==="verified_artifact"))) {
    const row=currentProducerArtifacts(db,runId,edge.sourceNodeId,edge.sourceOutput)[0];
    if (!row) continue;inputs.push(safeArtifactReference(row,edge.targetInput));
  }
  return inputs;
}

export function recoveryDraftForAttempt(db:Database.Database,runId:string,nodeId:string,
  attemptNumber:number):TaskGraphRecoveryDraft|null {
  if (attemptNumber<2) return null;
  const row=db.prepare(`SELECT a.id,a.terminal_witness_json,s.final_report AS session_final_report
    FROM task_node_attempts a LEFT JOIN sessions s ON s.session_key=a.session_run_key
    WHERE a.run_id=? AND a.node_id=? AND a.attempt_number<? AND a.runtime='terminal'
    ORDER BY a.attempt_number DESC LIMIT 1`).get(runId,nodeId,attemptNumber) as Row|undefined;
  if (!row) return null;
  let stagingFailure:TaskGraphRecoveryDraft["stagingFailure"];
  let witnessFinalReport="";
  try {
    const witness=JSON.parse(String(row.terminal_witness_json??"{}")) as Record<string,unknown>;
    witnessFinalReport=typeof witness["finalReport"]==="string"?witness["finalReport"].trim():"";
    const raw=witness["stagingFailure"];
    if (raw&&typeof raw==="object") {
      const value=raw as Record<string,unknown>;
      stagingFailure={
        missingOutputs:Array.isArray(value["missingOutputs"])
          ?value["missingOutputs"].filter((item):item is string=>typeof item==="string"):[],
        stagedOutputs:Array.isArray(value["stagedOutputs"])
          ?value["stagedOutputs"].filter((item):item is string=>typeof item==="string"):[],
      };
    }
  } catch { /* Only a structured artifact-staging witness permits draft reuse. */ }
  if (!stagingFailure) return null;
  const sessionFinalReport=typeof row.session_final_report==="string"
    ?row.session_final_report.trim():"";
  const finalReport=witnessFinalReport||sessionFinalReport;
  if (!finalReport) return null;
  return {attemptId:String(row.id),finalReport:finalReport.slice(0,12_000),
    stagingFailure};
}
