import { graphRevisionInputSchema, type GraphRevisionInput } from "../../shared/task-graph-contracts.ts";
import { TaskGraphValidationError } from "./errors.ts";
import path from "node:path";
import {artifactContractExample,validateArtifactContract} from "./artifact-contract.ts";

export type TaskGraphNodePolicyValidator = (
  node: GraphRevisionInput["nodes"][number],
) => void;

export function validateRevision(
  raw: unknown,
  validateNodePolicy?: TaskGraphNodePolicyValidator,
): GraphRevisionInput {
  const parsed = graphRevisionInputSchema.safeParse(raw);
  if (!parsed.success) throw new TaskGraphValidationError(parsed.error.message);
  const revision = parsed.data;
  const nodeIds = new Set<string>();
  for (const node of revision.nodes) {
    if (nodeIds.has(node.id)) throw new TaskGraphValidationError(`duplicate node id: ${node.id}`);
    nodeIds.add(node.id);
    for (const ownership of node.ownershipRequest) {
      if (ownership.scope !== "path") continue;
      const normalized=path.posix.normalize(ownership.normalizedValue.replaceAll("\\","/"));
      if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")
        || normalized !== ownership.normalizedValue.replaceAll("\\","/")
        || /[*?\[\]{}]/.test(normalized)) {
        throw new TaskGraphValidationError(`node ${node.id} has a non-canonical ownership path`);
      }
    }
    for (const [outputName,schema] of Object.entries(node.outputSchemas)) {
      const example=artifactContractExample(schema);
      try { validateArtifactContract(example,schema); }
      catch (error) {
        throw new TaskGraphValidationError(
          `node ${node.id} output ${outputName} has no valid accepted example: ${error instanceof Error?error.message:String(error)} Add an example or examples value that satisfies the declared JSON Schema before execution.`,
        );
      }
    }
    validateNodePolicy?.(node);
  }
  const edgeIds = new Set<string>();
  const outgoing = new Map<string, string[]>();
  for (const edge of revision.edges) {
    if (edgeIds.has(edge.id)) throw new TaskGraphValidationError(`duplicate edge id: ${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) {
      throw new TaskGraphValidationError(`edge ${edge.id} has unknown endpoint`);
    }
    if (edge.sourceNodeId === edge.targetNodeId) throw new TaskGraphValidationError(`self cycle: ${edge.id}`);
    if (edge.satisfactionPolicy === "reduce") {
      throw new TaskGraphValidationError(`edge ${edge.id} uses an unsupported reduction policy`);
    }
    if ((edge.kind === "artifact" || edge.kind === "verified_artifact") && (!edge.sourceOutput || !edge.targetInput)) {
      throw new TaskGraphValidationError(`edge ${edge.id} requires artifact bindings`);
    }
    if (edge.kind === "artifact" || edge.kind === "verified_artifact") {
      const source=revision.nodes.find(node=>node.id===edge.sourceNodeId)!;
      const target=revision.nodes.find(node=>node.id===edge.targetNodeId)!;
      if (!(edge.sourceOutput! in source.outputSchemas)) {
        throw new TaskGraphValidationError(
          `edge ${edge.id} sourceOutput "${edge.sourceOutput}" is not declared in source node ${source.id}.outputSchemas`,
        );
      }
      if (!(edge.targetInput! in target.inputBindings)) {
        throw new TaskGraphValidationError(
          `edge ${edge.id} targetInput "${edge.targetInput}" is not declared in target node ${target.id}.inputBindings`,
        );
      }
      if (edge.kind === "verified_artifact" && !source.verificationRequired) {
        throw new TaskGraphValidationError(`edge ${edge.id} requires a verified source node`);
      }
      if (!schemasCompatible(source.outputSchemas[edge.sourceOutput!],target.inputBindings[edge.targetInput!])) {
        throw new TaskGraphValidationError(`edge ${edge.id} has incompatible artifact schemas`);
      }
    }
    outgoing.set(edge.sourceNodeId, [...(outgoing.get(edge.sourceNodeId) ?? []), edge.targetNodeId]);
  }
  for (const id of revision.terminalNodeIds) if (!nodeIds.has(id)) {
    throw new TaskGraphValidationError(`unknown terminal node: ${id}`);
  }
  for (const node of revision.nodes) {
    const outgoingEdges=revision.edges.filter(edge=>edge.sourceNodeId===node.id);
    if (node.failurePolicy==="activate_fallback_node") {
      throw new TaskGraphValidationError(`node ${node.id} uses an unsupported fallback policy`);
    }
    if (node.verificationRequired && Object.keys(node.outputSchemas).length===0) {
      throw new TaskGraphValidationError(`node ${node.id} requires verification but declares no outputs`);
    }
    if (node.completionMode==="verification" && node.acceptanceCriteria.length===0) {
      throw new TaskGraphValidationError(`verification-mode node ${node.id} declares no acceptance criteria`);
    }
    if (node.failurePolicy==="continue_optional"
      && (revision.terminalNodeIds.includes(node.id)
        || outgoingEdges.some(edge=>!edge.optional && edge.failurePolicy!=="skip"))) {
      throw new TaskGraphValidationError(`node ${node.id} can continue only through optional or skipped edges`);
    }
    if (node.failurePolicy==="satisfy_all_terminal_only"
      && outgoingEdges.some(edge=>!edge.optional && edge.satisfactionPolicy!=="all_terminal")) {
      throw new TaskGraphValidationError(`node ${node.id} requires all-terminal outgoing joins`);
    }
  }
  for (const nodeId of nodeIds) {
    const incomingEdges=revision.edges.filter(edge=>edge.targetNodeId===nodeId && !edge.optional);
    const policies=new Set(incomingEdges.map(edge=>edge.satisfactionPolicy));
    if (policies.size>1) throw new TaskGraphValidationError(`node ${nodeId} mixes join satisfaction policies`);
    if (policies.has("quorum")) {
      const quorums=new Set(incomingEdges.map(edge=>edge.quorum ?? Math.ceil(incomingEdges.length/2)));
      const quorum=[...quorums][0] ?? 0;
      if (quorums.size!==1 || quorum<1 || quorum>new Set(incomingEdges.map(edge=>edge.sourceNodeId)).size) {
        throw new TaskGraphValidationError(`node ${nodeId} has an invalid quorum`);
      }
    }
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new TaskGraphValidationError("graph must be acyclic");
    if (visited.has(id)) return;
    visiting.add(id); for (const next of outgoing.get(id) ?? []) visit(next);
    visiting.delete(id); visited.add(id);
  };
  for (const id of nodeIds) visit(id);
  return revision;
}

function schemasCompatible(output:unknown,input:unknown): boolean {
  if (!output || !input || typeof output !== "object" || typeof input !== "object") return true;
  const outputType=(output as Record<string,unknown>)["type"];
  const inputType=(input as Record<string,unknown>)["type"];
  return typeof outputType !== "string" || typeof inputType !== "string" || outputType === inputType;
}
