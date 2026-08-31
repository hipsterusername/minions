import type { SemanticTaskGraphPlan } from "../../shared/task-graph-planning-contracts.ts";
import {
  taskGraphPatternDescriptor,
  type TaskGraphPatternId,
  type TaskGraphPatternRecommendation,
  type TaskGraphProblemSignature,
} from "../../shared/task-graph-patterns.ts";

export interface TaskGraphLintFinding {
  code: "graph_theater" | "weak_artifact_contract" | "correlated_ensemble"
    | "partial_coverage" | "missing_stop_rule" | "pattern_mismatch"
    | "pattern_conformance" | "acceptance_coverage" | "verification_gap"
    | "iteration_provenance";
  message: string;
  stepKeys: string[];
}

export function routeTaskGraphPattern(plan: SemanticTaskGraphPlan): TaskGraphPatternRecommendation {
  const signature = plan.problemSignature;
  if (signature) {
    const routed = routeSignature(signature);
    if (routed) return recommendation(routed.id, routed.reason, "problem_signature");
  }
  const dependencies = plan.steps.flatMap((step) => step.dependsOn);
  if (plan.steps.length === 1) return recommendation("p00.direct",
    "One bounded step has no meaningful graph handoff.", "expanded_topology");
  if (dependencies.some((dependency) => dependency.satisfactionPolicy === "quorum")) {
    return recommendation("p04.quorum_ensemble",
      "The expanded topology contains a quorum join.", "expanded_topology");
  }
  if (hasSurvivorshipJoin(plan)) return recommendation("p05.survivorship_synthesis",
    "The topology waits for terminal branches and consumes optional surviving artifacts.",
    "expanded_topology");
  if (dependencies.some((dependency) => dependency.kind === "verified_artifact")
    || plan.steps.some((step) => step.verificationRequired)) {
    return recommendation("p07.independent_verification",
      "The plan requires independent verification of producer artifacts.", "expanded_topology");
  }
  if (hasParallelWork(plan)) return recommendation("p02.fork_join",
    "The expanded topology contains independent branches and a downstream join.",
    "expanded_topology");
  return recommendation("p01.pipeline",
    "The expanded topology is an ordered sequence of bounded stages.", "expanded_topology");
}

export function lintSemanticGraphPlan(plan: SemanticTaskGraphPlan, input: {
  recommendation?: TaskGraphPatternRecommendation;
  baseProposalRevision?: number | null;
} = {}): TaskGraphLintFinding[] {
  const findings: TaskGraphLintFinding[] = [];
  const route = input.recommendation ?? routeTaskGraphPattern(plan);
  if (plan.steps.length === 1) findings.push(finding("graph_theater",
    "This plan has one bounded step; direct execution or direct delegation is likely cheaper and safer.",
    [plan.steps[0]!.key]));

  for (const target of plan.steps) for (const dependency of target.dependsOn) {
    if (dependency.kind === "control") continue;
    const source = plan.steps.find((step) => step.key === dependency.stepKey);
    const schema = source?.outputSchemas[dependency.sourceOutput ?? ""];
    if (!hasExplicitJsonType(schema)) findings.push(finding("weak_artifact_contract",
      `Artifact ${dependency.sourceOutput ?? "(unnamed)"} from ${dependency.stepKey} does not declare an explicit JSON Schema type.`,
      [dependency.stepKey, target.key]));
  }

  for (const target of plan.steps) {
    const required = target.dependsOn.filter((dependency) => !dependency.optional);
    if (required.length > 1 && required.every((dependency) =>
      dependency.satisfactionPolicy === "quorum" || dependency.satisfactionPolicy === "any_success")) {
      const sources = required.map((dependency) => plan.steps.find((step) => step.key === dependency.stepKey))
        .filter((step): step is SemanticTaskGraphPlan["steps"][number] => Boolean(step));
      if (sources.length > 1 && new Set(sources.map(independenceFingerprint)).size === 1
        && !mentions(plan, /independen|divers|different source|different method/i)) {
        findings.push(finding("correlated_ensemble",
          `Join ${target.key} treats structurally identical branches as an ensemble without an independence statement.`,
          [...sources.map((step) => step.key), target.key]));
      }
    }
    if (target.dependsOn.some((dependency) => dependency.optional
      || ["all_terminal","any_success","quorum"].includes(dependency.satisfactionPolicy))
      && !target.acceptanceCriteria.some((criterion) => /coverage|missing|partial|failed branch/i.test(criterion))) {
      findings.push(finding("partial_coverage",
        `Step ${target.key} can receive partial evidence but does not require coverage and missing-evidence disclosure.`,
        [target.key]));
    }
  }

  if (plan.pattern?.id === "p09.hypothesis_tournament"
    && !mentions(plan, /stop|depth|breadth|branch cap|prun|budget|round/i)) {
    findings.push(finding("missing_stop_rule",
      "The hypothesis-tournament pattern needs an explicit breadth/depth or stopping rule.", []));
  }
  if (plan.pattern && plan.pattern.id !== route.id) findings.push(finding("pattern_mismatch",
    `Selected pattern ${plan.pattern.id} differs from the router recommendation ${route.id}: ${route.rationale}`,
    []));
  findings.push(...patternConformance(plan));

  for (const criterion of plan.acceptanceCriteria) if (!plan.steps.some((step) =>
    step.acceptanceCriteria.includes(criterion))) findings.push(finding("acceptance_coverage",
      `Mission acceptance criterion is not explicitly mapped to a producer or verifier step: ${criterion}`,
      []));
  const promisesVerification = plan.acceptanceCriteria.some((criterion) =>
    /independent.{0,30}verif|verif.{0,30}independent/i.test(criterion));
  if (promisesVerification && !plan.steps.some((step) => step.verificationRequired
    || step.completionMode === "verification")) findings.push(finding("verification_gap",
    "The mission promises independent verification but no producer requires verification and no verification-mode step is declared.",
    []));

  if ((input.baseProposalRevision ?? 0) > 0 && !plan.iteration) findings.push(finding(
    "iteration_provenance",
    "This successor proposal should identify the new evidence or guidance, episode number, and stop condition.", []));
  if (!input.baseProposalRevision && plan.iteration?.strategy === "successor_revision") findings.push(finding(
    "iteration_provenance",
    "Successor-revision metadata was supplied for an initial proposal with no base revision.", []));
  return deduplicate(findings);
}

function routeSignature(signature: TaskGraphProblemSignature): { id:TaskGraphPatternId;reason:string } | null {
  if (signature.taskKind === "dialectic") return {id:"p13.dialectic",reason:"The task explicitly requests bounded, role-differentiated dialogue with synthesis and Leader moderation."};
  if (signature.deepUncertainty) return {id:"p14.scenario_stress_test",reason:"Deep uncertainty favors bounded scenario stress testing."};
  if (signature.taskKind === "diagnosis") return {id:"p10.causal_diagnosis",reason:"The task is diagnostic and needs discriminating causal evidence."};
  if (signature.taskKind === "decision") return {id:"p11.value_focused_decision",reason:"The task separates decision authority, objectives, alternatives, and uncertainty."};
  if (signature.taskKind === "comparison") return {id:"p12.multi_criteria_scorecard",reason:"Known alternatives need explicit criteria and sensitivity analysis."};
  if (signature.taskKind === "search") return {id:"p09.hypothesis_tournament",reason:"Several possible routes need bounded testing and pruning."};
  if (signature.taskKind === "design" && signature.goalClarity === "ambiguous") return {id:"p18.double_diamond",reason:"Both the problem frame and solution need controlled divergence and convergence."};
  if (signature.taskKind === "schedule") return {id:"p16.critical_path_delivery",reason:"Dependency timing and bottlenecks dominate the objective."};
  if (signature.taskKind === "partitioned_batch") return {id:"p03.static_scatter_gather",reason:"One operation applies to a known bounded set of homogeneous partitions."};
  if (signature.taskKind === "draft_refinement") return {id:"p08.generate_critique_revise_verify",reason:"A reviewable draft needs bounded critique, revision, and final verification."};
  if (signature.procedure === "hierarchical") return {id:"p15.hierarchical_decomposition",reason:"The work has reusable hierarchical decomposition."};
  if (signature.taskKind === "research" && signature.evidenceModes === "multiple") return {id:"p06.evidence_triangulation",reason:"The conclusion needs materially different evidence modes."};
  if (signature.verificationNeed === "independent") return {id:"p07.independent_verification",reason:"Consequential outputs require independent verification."};
  if (signature.decomposability === "high") return {id:"p02.fork_join",reason:"The work decomposes into independent branches."};
  return null;
}

function recommendation(id:TaskGraphPatternId,rationale:string,
  source:TaskGraphPatternRecommendation["source"]):TaskGraphPatternRecommendation {
  const descriptor=taskGraphPatternDescriptor(id);
  return {id,version:descriptor.version,label:descriptor.label,rationale,source};
}

function patternConformance(plan:SemanticTaskGraphPlan):TaskGraphLintFinding[] {
  const selected=plan.pattern?.id;if (!selected) return [];
  const dependencies=plan.steps.flatMap(step=>step.dependsOn);
  if (selected==="p02.fork_join"&&!hasParallelWork(plan)) return [finding("pattern_conformance",
    "The selected fork-join pattern has no independent branches followed by a join.",[])];
  if (selected==="p04.quorum_ensemble"&&!dependencies.some(edge=>edge.satisfactionPolicy==="quorum")) {
    return [finding("pattern_conformance","The selected quorum-ensemble pattern has no quorum join.",[])];
  }
  if (selected==="p05.survivorship_synthesis"&&!hasSurvivorshipJoin(plan)) return [finding(
    "pattern_conformance","The selected survivorship pattern needs all-terminal control and optional artifact dependencies.",[])];
  if (selected==="p07.independent_verification"&&!dependencies.some(edge=>edge.kind==="verified_artifact")
    &&!plan.steps.some(step=>step.verificationRequired||step.completionMode==="verification")) return [finding(
      "pattern_conformance","The selected independent-verification pattern has no verification boundary.",[])];
  if (selected==="p13.dialectic") return dialecticConformance(plan);
  return [];
}

function dialecticConformance(plan:SemanticTaskGraphPlan):TaskGraphLintFinding[] {
  const nodes=plan.steps.filter(step=>step.reasoning?.kind==="dialectic");
  const turns=nodes.filter(step=>step.reasoning?.phase==="turn");
  const syntheses=nodes.filter(step=>step.reasoning?.phase==="synthesis");
  const participants=new Map<string,{role:string;fingerprint:string}>();
  for (const step of turns) {
    const metadata=step.reasoning!;
    participants.set(metadata.participantId,{role:metadata.role,
      fingerprint:JSON.stringify({harnesses:step.allowedHarnesses??[],model:step.model??null,
        executorClass:step.executorClass})});
  }
  const findings:TaskGraphLintFinding[]=[];
  if (participants.size<2) findings.push(finding("pattern_conformance",
    "A dialectic requires at least two explicit participant identities.",turns.map(step=>step.key)));
  if (new Set([...participants.values()].map(item=>item.role.trim().toLowerCase())).size
    <participants.size) findings.push(finding("pattern_conformance",
    "Dialectic participants must have materially distinct epistemic roles.",turns.map(step=>step.key)));
  if (syntheses.length===0) findings.push(finding("pattern_conformance",
    "A dialectic requires at least one synthesis node.",[]));
  if (nodes.some(step=>!step.sessionAffinity)) findings.push(finding("pattern_conformance",
    "Every dialectic turn and synthesis node requires provider-thread affinity.",
    nodes.filter(step=>!step.sessionAffinity).map(step=>step.key)));
  for (const synthesis of syntheses.filter(step=>!step.reasoning?.final)) {
    const gated=plan.steps.some(target=>target.dependsOn.some(edge=>
      edge.stepKey===synthesis.key&&edge.kind==="human_gate"));
    if (!gated) findings.push(finding("pattern_conformance",
      `Non-final synthesis ${synthesis.key} must hand control to the Leader through a human gate.`,
      [synthesis.key]));
  }
  if (participants.size>=2 && new Set([...participants.values()].map(item=>item.fingerprint)).size===1
    && !mentions(plan,/different role|epistemic|adversarial|oppos|critic|challenge/i)) {
    findings.push(finding("correlated_ensemble",
      "Dialectic participants share the same runtime profile; record how their roles create meaningful cognitive diversity.",
      turns.map(step=>step.key)));
  }
  return findings;
}

function hasParallelWork(plan:SemanticTaskGraphPlan):boolean {
  const ancestors=new Map(plan.steps.map(step=>[step.key,new Set(step.dependsOn.map(edge=>edge.stepKey))]));
  return plan.steps.some(target=>target.dependsOn.length>1
    && new Set(target.dependsOn.map(edge=>edge.stepKey)).size>1)
    || [...ancestors.values()].filter(set=>set.size===0).length>1;
}

function hasSurvivorshipJoin(plan:SemanticTaskGraphPlan):boolean {
  return plan.steps.some(target=>target.dependsOn.some(edge=>!edge.optional
    &&edge.kind==="control"&&edge.satisfactionPolicy==="all_terminal")
    &&target.dependsOn.some(edge=>edge.optional&&edge.kind!=="control"));
}

function hasExplicitJsonType(schema:unknown):boolean {
  return Boolean(schema&&typeof schema==="object"&&typeof (schema as Record<string,unknown>)["type"]==="string");
}

function independenceFingerprint(step:SemanticTaskGraphPlan["steps"][number]):string {
  return JSON.stringify({executorClass:step.executorClass,harnesses:step.allowedHarnesses??[],
    tools:step.allowedTools??[],context:step.contextSelectors});
}

function mentions(plan:SemanticTaskGraphPlan,pattern:RegExp):boolean {
  return [...plan.acceptanceCriteria,...plan.constraints,...plan.assumptions,
    ...plan.steps.flatMap(step=>[...step.acceptanceCriteria,...step.constraints])]
    .some(value=>pattern.test(value));
}

function finding(code:TaskGraphLintFinding["code"],message:string,
  stepKeys:string[]):TaskGraphLintFinding { return {code,message,stepKeys}; }

function deduplicate(findings:TaskGraphLintFinding[]):TaskGraphLintFinding[] {
  return [...new Map(findings.map(item=>[`${item.code}:${item.message}`,item])).values()];
}
