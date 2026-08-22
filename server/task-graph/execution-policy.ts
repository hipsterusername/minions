import type { AgentHarness } from "../harness/types.ts";
import { getHarness } from "../harness/index.ts";
import type { TaskNode } from "../../shared/task-graph-contracts.ts";
import type { SandboxPolicy } from "../../shared/workspace-contracts.ts";
import { TaskGraphValidationError } from "./errors.ts";

const READ_ONLY_GRAPH_SANDBOX:SandboxPolicy={filesystemScope:"read-only",approvalPolicy:"never"};
const WRITE_GRAPH_SANDBOX:SandboxPolicy={filesystemScope:"workspace-write",approvalPolicy:"never"};
const GENERIC_NATIVE_TOOL_ALIASES=new Set(["file","filesystem","shell"]);

function resolveTaskGraphHarness(node:TaskNode,resolveHarness:(name:string)=>AgentHarness,
  name=node.allowedHarnesses[0]!):AgentHarness {
  try { return resolveHarness(name); }
  catch { throw new TaskGraphValidationError(
    `node ${node.id} references an unregistered harness: ${name}`); }
}

/** Return only a sandbox whose complete provider-neutral guarantees are declared by the harness. */
export function sandboxPolicyForTaskGraphNode(
  node:TaskNode,
  resolveHarness:(name:string)=>AgentHarness=getHarness,
):SandboxPolicy|undefined {
  const selected=resolveTaskGraphHarness(node,resolveHarness);
  const writes=node.ownershipRequest.some(scope=>scope.mode==="write");
  if (!selected.capabilities.builtInFilesystem
    || selected.capabilities.mutationInterception==="complete") return undefined;
  const policy=writes?WRITE_GRAPH_SANDBOX:READ_ONLY_GRAPH_SANDBOX;
  const support=selected.capabilities.sandboxEnforcement;
  if (!support?.filesystem.includes(policy.filesystemScope) || !support.approval) {
    throw new TaskGraphValidationError(
      `node ${node.id} requires enforced ${policy.filesystemScope} filesystem and never-approval sandboxing on harness ${selected.name}`,
    );
  }
  return policy;
}

/** Validate only capabilities the server can actually expose to a graph child. */
export function validateTaskGraphNodePolicy(
  node:TaskNode,
  resolveHarness:(name:string)=>AgentHarness=getHarness,
):void {
  const selected=node.allowedHarnesses.map(name=>resolveTaskGraphHarness(node,resolveHarness,name))[0]!;
  if (node.ownershipRequest.some(scope=>scope.mode==="write" && scope.scope==="symbol")) {
    throw new TaskGraphValidationError(`node ${node.id} requests unsupported symbol write ownership`);
  }
  const writes=node.ownershipRequest.some(scope=>scope.mode==="write");
  const sandbox=sandboxPolicyForTaskGraphNode(node,()=>selected);
  if (writes && selected.capabilities.mutationInterception!=="complete"
    && sandbox?.filesystemScope!=="workspace-write") {
    throw new TaskGraphValidationError(
      `node ${node.id} requires enforced writes unavailable on harness ${selected.name}`,
    );
  }
  const supported=new Set([...selected.builtInTools,"mcp__skills__load_subskill",
    "mcp__task-graph__read_input_artifact","mcp__task-graph__stage_output_artifact"]);
  const unsupported=node.allowedTools.filter(name=>!supported.has(name));
  if (unsupported.length) {
    const genericAliases=unsupported.filter(name=>GENERIC_NATIVE_TOOL_ALIASES.has(
      name.trim().toLowerCase()));
    if (genericAliases.length) throw new TaskGraphValidationError(
      `node ${node.id} uses generic shell/filesystem aliases that are not tool allowlist identifiers: ${genericAliases.join(", ")}. allowedTools accepts only exact harness built-in or fully qualified MCP identifiers; omit allowedTools to inherit harness-native shell/filesystem access`,
    );
    throw new TaskGraphValidationError(
      `node ${node.id} requests tools unavailable on harness ${selected.name}: ${unsupported.join(", ")}`,
    );
  }
}
