import { z } from 'zod';

// Standalone projection of the external snapshot protocol; never load app runtime.
const id = z.string().min(1);
const attempt = z.object({id, number:z.number().int().positive(),state:id,startedAt:z.iso.datetime().optional(),finishedAt:z.iso.datetime().optional(),tokens:z.number().nonnegative().optional(),sessionId:id.optional(),executor:id.optional()});
const evidence = z.object({id,sourceSnapshot:id,producerAttemptId:id,artifactId:id,verifierAttemptId:id.optional(),consumerNodeIds:z.array(id),consumedByNodeIds:z.array(id).default([]),status:id});
const graph = z.object({graphRunId:id,revision:z.number().int().nonnegative(),status:id,updatedAt:z.iso.datetime().optional(),nodes:z.array(z.object({id,title:id.optional(),kind:id.optional(),logicalState:id,attemptHistory:z.array(attempt),currentAttempt:attempt.nullable().optional(),outputArtifactIds:z.array(id).default([]),adjudication:z.object({decision:id,attemptId:id,actor:id,reason:id,guidance:id.optional(),createdAt:z.iso.datetime()}).nullable().optional()})),edges:z.array(z.object({id,source:id,target:id,type:id,state:id})),evidence:z.array(evidence).default([])});
export type GraphProvenance = Omit<z.infer<typeof graph>, 'nodes'>;
export interface GraphTimelineRow {
 readonly id:string; readonly title?:string; readonly kind?:string; readonly parentId?:string;
 readonly dependencies?:readonly string[]; readonly state:string; readonly attemptState?:string;
 readonly attemptId?:string; readonly attempt?:number; readonly startedAt?:string; readonly endedAt?:string;
 readonly tokens?:number; readonly sessionId?:string; readonly executor?:string;
 readonly outputArtifactIds?:readonly string[]; readonly adjudication?:z.infer<typeof graph>['nodes'][number]['adjudication'];
}
export function projectGraph(value:unknown): {graphTimeline:GraphTimelineRow[];graphProvenance:GraphProvenance} {
 const parsed=graph.parse(value), {nodes,...graphProvenance}=parsed;
 const graphTimeline=nodes.flatMap(node=>{
  const attempts=new Map(node.attemptHistory.map(a=>[a.id,a]));
  // Current state can be fresher than its history entry; identity prevents double counting.
  if(node.currentAttempt) attempts.set(node.currentAttempt.id,{...attempts.get(node.currentAttempt.id),...node.currentAttempt});
  const base={id:node.id,title:node.title,kind:node.kind,state:node.logicalState,dependencies:[...new Set(parsed.edges.filter(e=>e.target===node.id).map(e=>e.source))],outputArtifactIds:node.outputArtifactIds,adjudication:node.adjudication};
  if(!attempts.size)return [base];
  return [...attempts.values()].sort((a,b)=>a.number-b.number).map(a=>({...base,attemptId:a.id,attempt:a.number,attemptState:a.state,startedAt:a.startedAt,endedAt:a.finishedAt,tokens:a.tokens,sessionId:a.sessionId,executor:a.executor}));
 });
 return {graphTimeline,graphProvenance};
}
