import { z } from "zod/v4";

export const taskGraphPatternIdSchema = z.enum([
  "p00.direct",
  "p01.pipeline",
  "p02.fork_join",
  "p03.static_scatter_gather",
  "p04.quorum_ensemble",
  "p05.survivorship_synthesis",
  "p06.evidence_triangulation",
  "p07.independent_verification",
  "p08.generate_critique_revise_verify",
  "p09.hypothesis_tournament",
  "p10.causal_diagnosis",
  "p11.value_focused_decision",
  "p12.multi_criteria_scorecard",
  "p14.scenario_stress_test",
  "p15.hierarchical_decomposition",
  "p16.critical_path_delivery",
  "p18.double_diamond",
]);

export const taskGraphPatternProvenanceSchema = z.object({
  id: taskGraphPatternIdSchema,
  version: z.literal(1).default(1),
}).strict();

export const taskGraphPatternRecommendationSchema = z.object({
  id: taskGraphPatternIdSchema,
  version: z.literal(1),
  label: z.string().min(1),
  rationale: z.string().min(1),
  source: z.enum(["problem_signature", "expanded_topology"]),
}).strict();

export const taskGraphPatternTemplateViewSchema = z.object({
  id: taskGraphPatternIdSchema,
  version: z.literal(1),
  label: z.string().min(1),
  topology: z.string().min(1),
  requiredArtifacts: z.array(z.string().min(1)),
  safetyChecks: z.array(z.string().min(1)),
}).strict();

export const taskGraphProblemSignatureSchema = z.object({
  taskKind: z.enum([
    "delivery", "research", "diagnosis", "decision", "comparison", "search", "design", "schedule",
    "partitioned_batch", "draft_refinement",
  ]).default("delivery"),
  goalClarity: z.enum(["explicit", "ambiguous"]).default("explicit"),
  procedure: z.enum(["known", "unknown", "hierarchical"]).default("known"),
  decomposability: z.enum(["low", "high"]).default("low"),
  evidenceModes: z.enum(["single", "multiple"]).default("single"),
  alternatives: z.enum(["one", "several"]).default("one"),
  deepUncertainty: z.boolean().default(false),
  verificationNeed: z.enum(["ordinary", "independent"]).default("ordinary"),
}).strict();

export const taskGraphIterationSchema = z.object({
  strategy: z.enum(["single_episode", "successor_revision"]),
  episode: z.number().int().positive().default(1),
  reason: z.string().trim().min(1).max(1_000).optional(),
  evidenceRefs: z.array(z.string().trim().min(1)).max(50).default([]),
  stopCondition: z.string().trim().min(1).max(1_000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.strategy !== "successor_revision") return;
  if (value.episode < 2) ctx.addIssue({
    code: "custom", path: ["episode"], message: "a successor revision must be episode 2 or later",
  });
  if (!value.reason) ctx.addIssue({
    code: "custom", path: ["reason"], message: "a successor revision requires a reason",
  });
  if (value.evidenceRefs.length === 0) ctx.addIssue({
    code: "custom", path: ["evidenceRefs"],
    message: "a successor revision requires new evidence or human-guidance references",
  });
  if (!value.stopCondition) ctx.addIssue({
    code: "custom", path: ["stopCondition"],
    message: "a successor revision requires an explicit stop condition",
  });
});

export type TaskGraphPatternId = z.infer<typeof taskGraphPatternIdSchema>;
export type TaskGraphPatternProvenance = z.infer<typeof taskGraphPatternProvenanceSchema>;
export type TaskGraphPatternRecommendation = z.infer<typeof taskGraphPatternRecommendationSchema>;
export type TaskGraphPatternTemplateView = z.infer<typeof taskGraphPatternTemplateViewSchema>;
export type TaskGraphProblemSignature = z.infer<typeof taskGraphProblemSignatureSchema>;
export type TaskGraphIteration = z.infer<typeof taskGraphIterationSchema>;

export interface TaskGraphPatternDescriptor {
  id: TaskGraphPatternId;
  version: 1;
  label: string;
  support: "direct" | "semantic_native" | "static_encoding";
  intent: string;
  useWhen: string;
  avoidWhen: string;
  topology: string;
  requiredArtifacts: readonly TaskGraphAnalyticalArtifactName[];
  safetyChecks: readonly string[];
}

export const TASK_GRAPH_PATTERN_CATALOG: readonly TaskGraphPatternDescriptor[] = [
  { id:"p00.direct",version:1,label:"Direct execution",support:"direct",intent:"Complete one bounded objective without graph overhead.",useWhen:"One actor can satisfy the acceptance criteria without a meaningful handoff.",avoidWhen:"Independent verification, conflicting ownership, or durable multi-source synthesis matters.",topology:"Unit",requiredArtifacts:[],safetyChecks:["Prefer direct execution unless a graph-enabling signal exists."] },
  { id:"p01.pipeline",version:1,label:"Pipeline",support:"semantic_native",intent:"Transform a deliverable through ordered typed stages.",useWhen:"A known sequence transforms a deliverable through dependent stages.",avoidWhen:"The stages are artificial or can run independently.",topology:"Stage A -> Stage B -> Deliver",requiredArtifacts:[],safetyChecks:["Every consumed handoff is typed."] },
  { id:"p02.fork_join",version:1,label:"Independent fork-join",support:"semantic_native",intent:"Run disjoint workstreams concurrently and integrate them.",useWhen:"Distinct workstreams are independently executable and need integration.",avoidWhen:"Branches share writes, repeat the same method, or lack a real join.",topology:"Seed -> {A | B | C} -> Integrate",requiredArtifacts:["CoverageReport"],safetyChecks:["Parallel writes do not overlap."] },
  { id:"p03.static_scatter_gather",version:1,label:"Static scatter-gather",support:"static_encoding",intent:"Apply one operation to known partitions and gather coverage.",useWhen:"One operation applies uniformly to a known bounded partition set.",avoidWhen:"Partitions are unknown, coupled, or require different methods.",topology:"Partition -> {Map 1..n} -> Gather",requiredArtifacts:["CoverageReport"],safetyChecks:["Partition count and aggregate budget are bounded."] },
  { id:"p04.quorum_ensemble",version:1,label:"Quorum ensemble",support:"semantic_native",intent:"Aggregate a sufficient independent cohort under an explicit rule.",useWhen:"Several genuinely independent attempts can satisfy an explicit quorum rule.",avoidWhen:"Attempts are correlated or every branch is required.",topology:"{Attempt 1..n} -- q/n -> Aggregate",requiredArtifacts:["CoverageReport"],safetyChecks:["Independence and aggregation rules are explicit."] },
  { id:"p05.survivorship_synthesis",version:1,label:"Survivorship synthesis",support:"static_encoding",intent:"Produce a transparent partial result after all branches terminate.",useWhen:"A useful synthesis may proceed after failures using surviving evidence.",avoidWhen:"Missing any branch makes the result invalid or unsafe.",topology:"{A | B | C} -- all terminal -> Synthesize",requiredArtifacts:["CoverageReport"],safetyChecks:["Missing evidence and impact are disclosed."] },
  { id:"p06.evidence_triangulation",version:1,label:"Evidence triangulation",support:"semantic_native",intent:"Support claims with materially different evidence modes.",useWhen:"A conclusion needs corroboration from materially different evidence modes.",avoidWhen:"One authoritative source or deterministic test is sufficient.",topology:"Question -> {Sources | Repository | Empirical} -> Audit",requiredArtifacts:["EvidenceSet"],safetyChecks:["Evidence modes are materially distinct."] },
  { id:"p07.independent_verification",version:1,label:"Independent verification",support:"semantic_native",intent:"Gate consequential consumption on attempt-bound verification.",useWhen:"Consequential producer artifacts need attempt-bound independent verification.",avoidWhen:"The producer's ordinary checks are sufficient and consequence is low.",topology:"Producer -> verified artifact -> Consumer",requiredArtifacts:["VerificationVerdict"],safetyChecks:["Verifier is independent and bound to exact hashes."] },
  { id:"p08.generate_critique_revise_verify",version:1,label:"Generate, critique, revise, verify",support:"static_encoding",intent:"Improve a draft through bounded critique and verification.",useWhen:"A draft benefits from a separate critique, one bounded revision, and final verification.",avoidWhen:"There is no reviewable draft or iteration cannot be bounded.",topology:"Draft -> Critique -> Revision -> Verify",requiredArtifacts:["VerificationVerdict"],safetyChecks:["Revision rounds are bounded."] },
  { id:"p09.hypothesis_tournament",version:1,label:"Hypothesis tournament",support:"static_encoding",intent:"Test and prune a bounded set of competing explanations.",useWhen:"Several competing routes or explanations can be tested and pruned.",avoidWhen:"The candidate set, test budget, or stop rule is unbounded.",topology:"Frame -> {Hypotheses} -> Tests -> Prune -> Explain",requiredArtifacts:["HypothesisSet","TestResult","EvidenceSet"],safetyChecks:["Breadth, depth, pruning, and stopping rules are explicit."] },
  { id:"p10.causal_diagnosis",version:1,label:"Causal diagnosis",support:"semantic_native",intent:"Collect discriminating evidence for a causal or fault model.",useWhen:"The task asks why an event or fault occurred and remedies must be checked.",avoidWhen:"Only description or correlation is needed.",topology:"Event -> Cause model -> {Evidence | Tests} -> Remedy check",requiredArtifacts:["HypothesisSet","TestResult","EvidenceSet"],safetyChecks:["Association alone is not treated as intervention evidence."] },
  { id:"p11.value_focused_decision",version:1,label:"Value-focused decision",support:"semantic_native",intent:"Separate facts, values, alternatives, and accountable choice.",useWhen:"An accountable human must choose using explicit objectives and uncertainty.",avoidWhen:"The task has one mandated outcome or is only factual comparison.",topology:"Frame -> Evaluate -> Sensitivity -> Human choice",requiredArtifacts:["DecisionFrame","DecisionEvaluation"],safetyChecks:["Human decision authority is preserved."] },
  { id:"p12.multi_criteria_scorecard",version:1,label:"Multi-criteria scorecard",support:"semantic_native",intent:"Compare known alternatives with explicit criteria and sensitivity.",useWhen:"Known alternatives need transparent multi-criteria scoring and sensitivity.",avoidWhen:"Objectives are still disputed or hard constraints would be averaged away.",topology:"Criteria + Alternatives -> Score -> Sensitivity -> Human choice",requiredArtifacts:["DecisionFrame","DecisionEvaluation"],safetyChecks:["Hard constraints are not hidden in weighted sums."] },
  { id:"p14.scenario_stress_test",version:1,label:"Scenario stress test",support:"static_encoding",intent:"Compare strategies across bounded plausible futures.",useWhen:"Deep uncertainty makes robustness across plausible futures more useful than one forecast.",avoidWhen:"One stable forecast is adequate or scenarios cannot be bounded.",topology:"Frame -> Scenarios x Strategies -> Vulnerability -> Choice",requiredArtifacts:["ScenarioSet","DecisionEvaluation","RiskRegister"],safetyChecks:["Scenario and strategy counts are bounded."] },
  { id:"p15.hierarchical_decomposition",version:1,label:"Hierarchical decomposition",support:"static_encoding",intent:"Compile a reviewed bounded leaf DAG from reusable work packages.",useWhen:"A mission has reusable hierarchical work packages that compile to bounded leaves.",avoidWhen:"Decomposition depth or aggregate budget is unknown.",topology:"Mission -> Work packages -> Bounded leaf DAG -> Integrate",requiredArtifacts:["CoverageReport"],safetyChecks:["Depth and aggregate budget are capped."] },
  { id:"p16.critical_path_delivery",version:1,label:"Critical-path delivery",support:"semantic_native",intent:"Execute known dependencies while exposing schedule bottlenecks.",useWhen:"Known dependency timing and bottlenecks dominate delivery risk.",avoidWhen:"The route is exploratory or duration estimates are meaningless.",topology:"WBS -> Dependency DAG -> Deliver -> Schedule review",requiredArtifacts:["RiskRegister","CoverageReport"],safetyChecks:["Schedule heuristics never bypass scheduler authority."] },
  { id:"p18.double_diamond",version:1,label:"Double Diamond",support:"static_encoding",intent:"Diverge and converge over both problem framing and solutions.",useWhen:"Both the problem definition and solution space need bounded divergence and convergence.",avoidWhen:"The goal and delivery procedure are already explicit.",topology:"Discover -> Define -> Develop -> Evaluate -> Deliver",requiredArtifacts:["EvidenceSet","DecisionFrame","DecisionEvaluation"],safetyChecks:["Divergence and iteration remain bounded."] },
] as const;

export const TASK_GRAPH_PATTERN_AUTHORING_GUIDE = TASK_GRAPH_PATTERN_CATALOG
  .map((pattern) => `- ${pattern.id} (${pattern.label}): Use when ${pattern.useWhen} Avoid when ${pattern.avoidWhen}`)
  .join("\n");

export function taskGraphPatternDescriptor(id: TaskGraphPatternId): TaskGraphPatternDescriptor {
  return TASK_GRAPH_PATTERN_CATALOG.find((pattern) => pattern.id === id)!;
}

const text = { type:"string",minLength:1 } as const;
const textList = { type:"array",items:text } as const;

/** Reusable JSON Schemas for analytical artifacts; each includes a valid accepted example. */
export const TASK_GRAPH_ANALYTICAL_ARTIFACT_SCHEMAS = {
  EvidenceSet: {
    type:"object",required:["claims","limitations"],additionalProperties:false,
    properties:{claims:{type:"array",items:{type:"object",required:["claim","evidenceRefs"],properties:{claim:text,evidenceRefs:textList},additionalProperties:false}},limitations:textList},
    example:{claims:[],limitations:[]},
  },
  HypothesisSet: {
    type:"object",required:["hypotheses"],additionalProperties:false,
    properties:{hypotheses:{type:"array",items:{type:"object",required:["id","claim","predictions","falsifiers","status"],properties:{id:text,claim:text,predictions:textList,falsifiers:textList,status:{type:"string",enum:["open","supported","rejected","unresolved"]}},additionalProperties:false}}},
    example:{hypotheses:[]},
  },
  TestResult: {
    type:"object",required:["method","inputs","expected","observed","reproducible"],additionalProperties:false,
    properties:{method:text,inputs:{type:"object"},expected:text,observed:text,reproducible:{type:"boolean"}},
    example:{method:"deterministic check",inputs:{},expected:"pass",observed:"pass",reproducible:true},
  },
  DecisionFrame: {
    type:"object",required:["owner","alternatives","objectives","constraints","uncertainties","horizon"],additionalProperties:false,
    properties:{owner:text,alternatives:textList,objectives:textList,constraints:textList,uncertainties:textList,horizon:text},
    example:{owner:"accountable user",alternatives:[],objectives:[],constraints:[],uncertainties:[],horizon:"current decision"},
  },
  DecisionEvaluation: {
    type:"object",required:["evaluations","assumptions","sensitivity","reversalConditions"],additionalProperties:false,
    properties:{evaluations:{type:"array",items:{type:"object"}},assumptions:textList,sensitivity:textList,reversalConditions:textList},
    example:{evaluations:[],assumptions:[],sensitivity:[],reversalConditions:[]},
  },
  ScenarioSet: {
    type:"object",required:["factors","scenarios","bounds","signposts"],additionalProperties:false,
    properties:{factors:textList,scenarios:{type:"array",items:{type:"object"}},bounds:textList,signposts:textList},
    example:{factors:[],scenarios:[],bounds:[],signposts:[]},
  },
  RiskRegister: {
    type:"object",required:["risks"],additionalProperties:false,
    properties:{risks:{type:"array",items:{type:"object",required:["cause","event","consequence","controls","owner","residualRisk"],properties:{cause:text,event:text,consequence:text,controls:textList,owner:text,residualRisk:text},additionalProperties:false}}},
    example:{risks:[]},
  },
  VerificationVerdict: {
    type:"object",required:["result","confidence","criteria"],additionalProperties:false,
    properties:{result:{type:"string",enum:["passed","failed","inconclusive"]},confidence:{type:"number",minimum:0,maximum:1},criteria:{type:"array",items:{type:"object"}}},
    example:{result:"inconclusive",confidence:0,criteria:[]},
  },
  CoverageReport: {
    type:"object",required:["planned","completed","consumedArtifacts","missing","impact"],additionalProperties:false,
    properties:{planned:textList,completed:textList,consumedArtifacts:textList,missing:textList,impact:text},
    example:{planned:[],completed:[],consumedArtifacts:[],missing:[],impact:"No coverage assessed"},
  },
  PatternOutcome: {
    type:"object",required:["pattern","quality","latencyMs","costMicros","retries","humanInterventions"],additionalProperties:false,
    properties:{pattern:{type:"object",required:["id","version"],additionalProperties:false,
      properties:{id:{type:"string",enum:taskGraphPatternIdSchema.options},version:{type:"integer",const:1}}},
    quality:{type:"number",minimum:0,maximum:1},latencyMs:{type:"integer",minimum:0},costMicros:{type:"integer",minimum:0},retries:{type:"integer",minimum:0},humanInterventions:{type:"integer",minimum:0}},
    example:{pattern:{id:"p01.pipeline",version:1},quality:0,latencyMs:0,costMicros:0,retries:0,humanInterventions:0},
  },
} as const;

export type TaskGraphAnalyticalArtifactName = keyof typeof TASK_GRAPH_ANALYTICAL_ARTIFACT_SCHEMAS;
