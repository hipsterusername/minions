import type {
  GraphRevisionInput,
  TaskEdge,
  TaskNode,
} from "../../shared/task-graph-contracts.ts";
import {
  semanticTaskGraphPlanSchema,
  type SemanticTaskGraphPlan,
} from "../../shared/task-graph-planning-contracts.ts";
import { TaskGraphValidationError } from "./errors.ts";
import { contentHash } from "./hash.ts";
import { validateRevision, type TaskGraphNodePolicyValidator } from "./validation.ts";
import {routeTaskGraphPattern} from "./patterns.ts";

export interface CompileSemanticGraphPlanInput {
  workItemId: string;
  workspaceId: string;
  primaryRunKey: string;
  proposalRevision: number;
  plan: SemanticTaskGraphPlan;
  defaultHarness: string;
  defaultAllowedTools: string[];
  validateNodePolicy?: TaskGraphNodePolicyValidator;
}

export interface CompiledSemanticGraphPlan {
  revision: GraphRevisionInput;
  nodeIdsByStepKey: Record<string, string>;
  autoStartEligible: boolean;
}

export function compileSemanticGraphPlan(input: CompileSemanticGraphPlanInput): CompiledSemanticGraphPlan {
  const plan = semanticTaskGraphPlanSchema.parse(input.plan);
  const definitionId = canonicalId("definition", { workItemId: input.workItemId });
  const revisionId = canonicalId("revision", {
    workItemId: input.workItemId,
    primaryRunKey: input.primaryRunKey,
    proposalRevision: input.proposalRevision,
    plan,
  });
  const nodeIdsByStepKey = Object.fromEntries(plan.steps.map((step) => [
    step.key,
    canonicalId("node", { revisionId, stepKey: step.key }),
  ]));
  const nodes: TaskNode[] = plan.steps.map((step) => ({
    id: nodeIdsByStepKey[step.key]!,
    title: step.title,
    objective: step.objective,
    inputBindings: step.inputBindings,
    outputSchemas: step.outputSchemas,
    constraints: [
      ...step.constraints,
      ...step.contextSelectors.map((selector) => `Context selector: ${selector}`),
    ],
    acceptanceCriteria: step.acceptanceCriteria,
    executorClass: step.executorClass,
    allowedHarnesses: step.allowedHarnesses ?? [input.defaultHarness],
    ...(step.model ? { model:step.model } : {}),
    ...(step.sessionAffinity ? { sessionAffinity:step.sessionAffinity } : {}),
    ...(step.reasoning ? { reasoning:step.reasoning } : {}),
    allowedTools: step.allowedTools ?? input.defaultAllowedTools,
    ownershipRequest: step.ownershipRequest,
    budgetRequest: step.budgetRequest,
    timeoutMs: step.timeoutMs,
    retryPolicy: step.retryPolicy,
    completionMode: step.completionMode ?? "task",
    verificationRequired: step.verificationRequired,
    failurePolicy: step.failurePolicy ?? (step.completionMode === "verification"
      ? "block_for_decision" : "fail_graph"),
    expansionPolicy: null,
  }));
  const edges: TaskEdge[] = plan.steps.flatMap((target) => target.dependsOn.map((dependency) => {
    const sourceNodeId = nodeIdsByStepKey[dependency.stepKey]!;
    const targetNodeId = nodeIdsByStepKey[target.key]!;
    return {
      id: canonicalId("edge", { revisionId, sourceNodeId, targetNodeId, dependency }),
      sourceNodeId,
      targetNodeId,
      kind: dependency.kind,
      sourceOutput: dependency.sourceOutput,
      targetInput: dependency.targetInput,
      satisfactionPolicy: dependency.satisfactionPolicy,
      ...(dependency.quorum == null ? {} : { quorum: dependency.quorum }),
      failurePolicy: dependency.failurePolicy,
      optional: dependency.optional,
    };
  }));
  const terminalKeys = plan.terminalStepKeys ?? inferTerminalKeys(plan);
  assertTerminalCoverage(plan, terminalKeys);
  assertParallelWritesDoNotOverlap(plan);
  const revision = validateRevision({
    definitionId,
    revisionId,
    workItemId: input.workItemId,
    workspaceId: input.workspaceId,
    objective: plan.objective,
    acceptanceCriteria: plan.acceptanceCriteria,
    nonGoals: plan.nonGoals,
    constraints: [...plan.constraints, ...plan.assumptions.map((value) => `Assumption: ${value}`)],
    terminalNodeIds: terminalKeys.map((key) => nodeIdsByStepKey[key]!),
    nodes,
    edges,
    maxActiveAttempts: plan.maxActiveAttempts,
    ...(plan.budgetLimits ? { budgetLimits: plan.budgetLimits } : {}),
  }, input.validateNodePolicy);
  return {
    revision,
    nodeIdsByStepKey,
    autoStartEligible: plan.questions.length === 0
      && plan.steps.every((step) => !step.requiresApproval)
      && (!(plan.pattern || plan.problemSignature)
        || routeTaskGraphPattern(plan).id !== "p00.direct"),
  };
}

function inferTerminalKeys(plan: SemanticTaskGraphPlan): string[] {
  const sources = new Set(plan.steps.flatMap((step) => step.dependsOn.map((edge) => edge.stepKey)));
  const leaves = plan.steps.map((step) => step.key).filter((key) => !sources.has(key));
  if (leaves.length === 0) throw new TaskGraphValidationError("semantic plan has no terminal step");
  return leaves;
}

function assertTerminalCoverage(plan: SemanticTaskGraphPlan, terminalKeys: string[]): void {
  const terminal = new Set(terminalKeys);
  const outgoing = new Map<string, string[]>();
  for (const target of plan.steps) for (const dependency of target.dependsOn) {
    outgoing.set(dependency.stepKey, [...(outgoing.get(dependency.stepKey) ?? []), target.key]);
  }
  const reachesTerminal = (start: string): boolean => {
    const queue = [start];
    const seen = new Set<string>();
    while (queue.length) {
      const current = queue.shift()!;
      if (terminal.has(current)) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      queue.push(...(outgoing.get(current) ?? []));
    }
    return false;
  };
  for (const step of plan.steps) if (!reachesTerminal(step.key)) {
    throw new TaskGraphValidationError(`step ${step.key} cannot reach a terminal deliverable`);
  }
}

function assertParallelWritesDoNotOverlap(plan: SemanticTaskGraphPlan): void {
  const outgoing = new Map<string, string[]>();
  for (const target of plan.steps) for (const dependency of target.dependsOn) {
    outgoing.set(dependency.stepKey, [...(outgoing.get(dependency.stepKey) ?? []), target.key]);
  }
  const ordered = (source: string, target: string): boolean => {
    const queue = [source];
    const seen = new Set<string>();
    while (queue.length) {
      const current = queue.shift()!;
      if (current === target) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      queue.push(...(outgoing.get(current) ?? []));
    }
    return false;
  };
  for (let left = 0; left < plan.steps.length; left += 1) {
    const a = plan.steps[left]!;
    const aWrites = a.ownershipRequest.filter((item) => item.scope === "path" && item.mode === "write");
    for (let right = left + 1; right < plan.steps.length; right += 1) {
      const b = plan.steps[right]!;
      if (ordered(a.key, b.key) || ordered(b.key, a.key)) continue;
      const bWrites = b.ownershipRequest.filter((item) => item.scope === "path" && item.mode === "write");
      for (const aWrite of aWrites) for (const bWrite of bWrites) {
        if (pathsOverlap(aWrite.normalizedValue, bWrite.normalizedValue)) {
          throw new TaskGraphValidationError(
            `parallel steps ${a.key} and ${b.key} request overlapping writes`,
          );
        }
      }
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function canonicalId(kind: string, value: unknown): string {
  return `${kind}_${contentHash(value).slice("sha256:".length, "sha256:".length + 32)}`;
}
