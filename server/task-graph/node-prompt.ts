import type { GraphRevisionInput } from "../../shared/task-graph-contracts.ts";
import type { TaskGraphArtifactReference } from "./artifact-access.ts";
import {artifactContractExample} from "./artifact-contract.ts";

interface ScopedContext {
  sourceId: string;
  contentHash: string;
  classification: string;
  content: string;
}

export interface TaskGraphRecoveryDraft {
  attemptId:string;
  finalReport:string;
  stagingFailure?:{missingOutputs:string[];stagedOutputs:string[]}|undefined;
}

export function renderTaskGraphNodePrompt(
  revision: GraphRevisionInput,
  node: GraphRevisionInput["nodes"][number],
  attemptId: string,
  attemptNumber: number,
  sourceSnapshotId: string,
  inputArtifacts: TaskGraphArtifactReference[],
  steering: string[],
  scopedContext: ScopedContext[],
  recoveryDraft?:TaskGraphRecoveryDraft|null,
): string {
  return [
    `Mission: ${revision.objective}`,
    `Node: ${node.title}`,
    `Objective: ${node.objective}`,
    `Attempt: ${attemptNumber} (${attemptId})`,
    `Source snapshot: ${sourceSnapshotId}`,
    Object.keys(node.inputBindings).length
      ? `Input contract: ${JSON.stringify(node.inputBindings)}` : "",
    inputArtifacts.length
      ? `Resolved immutable inputs:\n${inputArtifacts.map((input) => `- ${JSON.stringify(input)}`).join("\n")}` : "",
    inputArtifacts.length
      ? "Read artifact content only through mcp__task-graph__read_input_artifact using the listed artifactId." : "",
    scopedContext.length
      ? `Frozen task-scoped context:\n${scopedContext.map((source) => [
        `### ${source.sourceId} (${source.classification}, ${source.contentHash})`, source.content,
      ].join("\n")).join("\n\n")}` : "",
    revision.nonGoals.length
      ? `Non-goals:\n${revision.nonGoals.map((value) => `- ${value}`).join("\n")}` : "",
    node.constraints.length
      ? `Constraints:\n${node.constraints.map((value) => `- ${value}`).join("\n")}` : "",
    steering.length
      ? `Revision-fenced steering:\n${steering.map((value) => `- ${value}`).join("\n")}` : "",
    recoveryDraft ? recoveryGuidance(recoveryDraft) : "",
    node.acceptanceCriteria.length
      ? `Acceptance criteria:\n${node.acceptanceCriteria.map((value) => `- ${value}`).join("\n")}` : "",
    node.completionMode === "verification"
      ? "This is a verification-mode step. Performing the checks is not success by itself. Your final report must be JSON only and exactly match {\"result\":\"passed\"|\"failed\"|\"inconclusive\",\"confidence\":0..1,\"summary\":\"optional concise evidence\"}. Only result=\"passed\" satisfies this node; never report passed unless the acceptance criteria are verified."
      : "",
    Object.keys(node.outputSchemas).length
      ? artifactStagingGuidance(node) : "",
    node.allowedTools.length ? `Allowed task-specific tools: ${node.allowedTools.join(", ")}.` : "",
    Object.keys(node.budgetRequest).length
      ? `Budget envelope: ${JSON.stringify(node.budgetRequest)}.` : "",
    node.completionMode === "verification"
      ? "Complete only this node's verification scope and return the required JSON verdict."
      : "Complete only this node's scope and provide a concise evidence-backed final report.",
  ].filter(Boolean).join("\n\n");
}

function artifactStagingGuidance(node:GraphRevisionInput["nodes"][number]):string {
  const contracts=Object.entries(node.outputSchemas).map(([name,schema])=>[
    `### ${name}`,
    `Exact JSON Schema: ${JSON.stringify(schema)}`,
    `Accepted example: ${JSON.stringify(artifactContractExample(schema))}`,
    `Required stage fields: ${JSON.stringify({source:"inline",outputName:name,
      schemaName:declaredText(schema,"schemaName","GraphOutput"),
      schemaVersion:declaredText(schema,"schemaVersion","1"),
      inlineJson:artifactContractExample(schema)})}`,
  ].join("\n")).join("\n\n");
  const writes=node.ownershipRequest.some(scope=>scope.mode==="write");
  const instruction=writes
    ? "Choose exactly one source variant: source=inline with inlineJson, or source=path with a workspace-relative storageRef."
    : "This node is filesystem-read-only, so use only source=inline with inlineJson; path-backed staging is unavailable.";
  return `Artifact output contracts (frozen before execution):\n${contracts}\n\nBefore reporting done, call mcp__task-graph__stage_output_artifact once for every declared output. ${instruction} The server derives contentHash and byteSize. If validation fails, repair only the rejected JSON and call the staging tool again; completed reasoning and successfully staged outputs remain in this attempt.`;
}

function recoveryGuidance(draft:TaskGraphRecoveryDraft):string {
  const staging=draft.stagingFailure
    ? `The prior attempt completed its reasoning but failed artifact submission. Missing outputs: ${draft.stagingFailure.missingOutputs.join(", ")||"none"}. Already staged in that attempt: ${draft.stagingFailure.stagedOutputs.join(", ")||"none"}.`
    : "A prior attempt produced a final draft that may be reused.";
  return `Recovery draft from ${draft.attemptId}:\n${staging}\nDo not repeat completed analysis unless the draft is substantively wrong. Repair or serialize the draft into the frozen output contract, restage every required output for this attempt, then return a concise report.\n\nPrior final report:\n${draft.finalReport}`;
}

function declaredText(schema:unknown,key:string,fallback:string):string {
  if (!schema || typeof schema!=="object") return fallback;
  const value=(schema as Record<string,unknown>)[key];
  return typeof value==="string"&&value?value:fallback;
}
