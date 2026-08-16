import type { GraphSnapshot } from "../../shared/task-graph-contracts.ts";
import { projectTaskGraphSnapshot } from "./view.ts";
import type { TaskGraphService } from "./service.ts";

/** Publish the complete initial/read projection for a graph run. */
export function publishTaskGraphSnapshot(
  service: TaskGraphService,
  snapshot: GraphSnapshot,
  cause: string,
): void {
  const at=service.now();
  const view=projectTaskGraphSnapshot(snapshot,service.scheduler.inspect(snapshot.run.id,at,
    service.availableDispatchSlots()>0),at);
  service.options.bus.emitToWorkItem?.(snapshot.run.workItemId,{
    type:"task_graph_snapshot",workItemId:snapshot.run.workItemId,runId:snapshot.run.id,
    revision:snapshot.run.revision,cause,snapshot:view,timestamp:at,
  });
}

/** Publish a compact, revisioned delta derived from canonical graph facts. */
export function publishTaskGraphChanged(
  service: TaskGraphService,
  snapshot: GraphSnapshot,
  cause: string,
): void {
  const at=service.now();
  const view=projectTaskGraphSnapshot(snapshot,service.scheduler.inspect(snapshot.run.id,at,
    service.availableDispatchSlots()>0),at);
  const currentEvents=snapshot.events.filter(event=>event.runRevision===snapshot.run.revision);
  const attemptNodes=new Map(snapshot.attempts.map(row=>[String(row["id"]),String(row["node_id"])]));
  const objectNodes=new Map<string,string>(attemptNodes);
  for (const rows of [snapshot.artifacts,snapshot.verifications,snapshot.verificationRequests,
    snapshot.humanInputs]) {
    for (const row of rows) {
      if (row["id"]!=null && row["node_id"]!=null) {
        objectNodes.set(String(row["id"]),String(row["node_id"]));
      }
    }
  }
  const affected=new Set<string>();
  for (const event of currentEvents) {
    if (objectNodes.has(event.objectId)) affected.add(objectNodes.get(event.objectId)!);
    else if (snapshot.revision.nodes.some(node=>node.id===event.objectId)) affected.add(event.objectId);
    else if (event.payload && typeof event.payload==="object" && "nodeId" in event.payload
      && typeof event.payload.nodeId==="string") affected.add(event.payload.nodeId);
  }
  const changedEdgeIds=new Set(snapshot.edgeEvaluations
    .filter(row=>Number(row["run_revision"])===snapshot.run.revision)
    .map(row=>String(row["edge_id"])));
  for (const edge of snapshot.revision.edges) if (changedEdgeIds.has(edge.id)) {
    affected.add(edge.sourceNodeId);
    affected.add(edge.targetNodeId);
  }
  if (cause==="run_cancelled") view.nodes.forEach(node=>affected.add(node.id));
  service.options.bus.emitToWorkItem?.(snapshot.run.workItemId,{
    type:"task_graph_changed",workItemId:snapshot.run.workItemId,runId:snapshot.run.id,
    revision:snapshot.run.revision,cause,timestamp:at,changes:{
      status:view.status,updatedAt:view.updatedAt,
      nodes:view.nodes.filter(node=>affected.has(node.id)),
      edges:view.edges.filter(edge=>changedEdgeIds.has(edge.id)),
      evidence:view.evidence.filter(item=>affected.has(attemptNodes.get(item.producerAttemptId)??"")),
      timeline:view.timeline.filter(item=>currentEvents.some(event=>`event:${event.sequence}`===item.id)),
      capacity:view.capacity,budget:view.budget,criticalPath:view.criticalPath,
    },
  });
}
