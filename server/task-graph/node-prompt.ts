import type { GraphRevisionInput } from "../../shared/task-graph-contracts.ts";
import type { TaskGraphArtifactReference } from "./artifact-access.ts";

interface ScopedContext {
  sourceId: string;
  contentHash: string;
  classification: string;
  content: string;
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
    node.acceptanceCriteria.length
      ? `Acceptance criteria:\n${node.acceptanceCriteria.map((value) => `- ${value}`).join("\n")}` : "",
    Object.keys(node.outputSchemas).length
      ? `Before reporting done, call mcp__task-graph__stage_output_artifact once for every declared output: ${Object.keys(node.outputSchemas).join(", ")}.` : "",
    node.allowedTools.length ? `Allowed task-specific tools: ${node.allowedTools.join(", ")}.` : "",
    Object.keys(node.budgetRequest).length
      ? `Budget envelope: ${JSON.stringify(node.budgetRequest)}.` : "",
    "Complete only this node's scope and provide a concise evidence-backed final report.",
  ].filter(Boolean).join("\n\n");
}
