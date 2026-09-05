import { z } from "zod/v4";
import {
  semanticTaskGraphPlanSchema,
  type SemanticTaskGraphPlan,
} from "../../shared/task-graph-planning-contracts.ts";
import {
  MAX_DIALECTIC_ROUNDS,
  type DialecticMode,
} from "../../shared/dialectic.ts";

const executorClassSchema=z.enum(["mechanical","standard","reasoning"]);
const participantSchema=z.object({
  role:z.string().trim().min(1).max(2_000).optional(),
  harness:z.string().trim().min(1).optional(),
  model:z.string().trim().min(1).optional(),
  executorClass:executorClassSchema.optional(),
}).strict();

export const submitDialecticGraphSchema=z.object({
  requestId:z.string().min(1).describe("Stable idempotency key for this dialectic proposal."),
  baseProposalRevision:z.number().int().positive().nullable().default(null),
  objective:z.string().trim().min(1).max(20_000),
  acceptanceCriteria:z.array(z.string().trim().min(1)).min(1).max(30).optional(),
  mode:z.enum(["ping-pong","proposer-critic","debate-synthesis"]).default("proposer-critic"),
  rounds:z.number().int().min(1).max(MAX_DIALECTIC_ROUNDS).default(4),
  checkpointEvery:z.number().int().min(1).max(MAX_DIALECTIC_ROUNDS).default(2),
  participantA:participantSchema.default({}),
  participantB:participantSchema.default({}),
  synthesizer:participantSchema.default({}),
  contextSelectors:z.array(z.string().trim().min(1)).max(100).default([]),
  workPacketId:z.string().min(1).nullable().optional(),
  budgetLimits:z.object({
    tokenLimit:z.number().int().nonnegative().nullable(),
    costMicrosLimit:z.number().int().nonnegative().nullable(),
  }).optional(),
}).strict().superRefine((value,ctx)=>{
  if (value.checkpointEvery>value.rounds) ctx.addIssue({code:"custom",path:["checkpointEvery"],
    message:"checkpointEvery cannot exceed the bounded round count"});
});

type SubmitDialecticGraphInput=z.infer<typeof submitDialecticGraphSchema>;
type Step=SemanticTaskGraphPlan["steps"][number];
type Dependency=Step["dependsOn"][number];

const text={type:"string",minLength:1} as const;
const textList={type:"array",items:text} as const;
export const DIALECTIC_TURN_SCHEMA={
  type:"object",additionalProperties:false,
  required:["participant","round","position","claims","uncertainties","questions"],
  properties:{
    participant:text,round:{type:"integer",minimum:1},position:text,
    claims:textList,uncertainties:textList,questions:textList,
  },
  example:{participant:"A",round:1,position:"Prefer the bounded migration.",
    claims:["It preserves compatibility."],uncertainties:["Runtime cost needs measurement."],
    questions:["Which failure mode matters most?"]},
} as const;

export const DIALECTIC_SYNTHESIS_SCHEMA={
  type:"object",additionalProperties:false,
  required:["goalDistance","summary","agreements","disagreements","unresolvedQuestions",
    "recommendation","moderation","candidateOutcome"],
  properties:{
    goalDistance:{type:"number",minimum:0,maximum:1},summary:text,
    agreements:textList,disagreements:textList,unresolvedQuestions:textList,
    recommendation:{type:"string",enum:["continue","reshape","stop"]},
    moderation:text,candidateOutcome:text,
  },
  example:{goalDistance:0.35,summary:"The core approach is sound but one risk remains.",
    agreements:["Use a bounded rollout."],disagreements:["How much compatibility to retain."],
    unresolvedQuestions:["What is the measurable stop condition?"],recommendation:"reshape",
    moderation:"Focus the next episode on the unresolved compatibility risk.",
    candidateOutcome:"Adopt the bounded rollout after the risk is resolved."},
} as const;

export function buildDialecticGraphPlan(raw:SubmitDialecticGraphInput):SemanticTaskGraphPlan {
  const input=submitDialecticGraphSchema.parse(raw);
  const roles=rolesFor(input.mode,input.participantA.role,input.participantB.role);
  if (roles.a.trim().toLowerCase()===roles.b.trim().toLowerCase()) {
    throw new Error("dialectic participant roles must be materially different");
  }
  const synthesisRole=input.synthesizer.role?.trim()||
    "Neutral synthesis: measure distance from the goal, preserve productive disagreement, identify missing evidence, and recommend continue, reshape, or stop.";
  const criteria=input.acceptanceCriteria??[
    "The final synthesis directly answers the objective with an actionable candidate outcome.",
    "Agreements, unresolved disagreements, missing evidence, and goal distance are explicit.",
    "Every non-final synthesis checkpoint returns control to the Leader before more dialogue runs.",
  ];
  const steps:Step[]=[];
  let previousB:string|null=null;
  let previousSynthesis:string|null=null;
  let synthesisSequence=0;
  let episodeTurnKeys:string[]=[];

  for (let round=1;round<=input.rounds;round+=1) {
    const aKey=`turn-a-${round}`;
    const aDependencies:Dependency[]=[];
    if (previousB) aDependencies.push(artifactDependency(previousB,"turn","peerTurn"));
    if (previousSynthesis&&isCheckpointBoundary(round-1,input.checkpointEvery,input.rounds)) {
      aDependencies.push(artifactDependency(previousSynthesis,"synthesis","checkpoint"));
      aDependencies.push(humanGate(previousSynthesis));
    }
    steps.push(participantStep({input,key:aKey,participantId:"A",role:roles.a,round,
      sequence:round-1,profile:input.participantA,defaultExecutor:"reasoning",
      dependsOn:aDependencies}));
    episodeTurnKeys.push(aKey);

    const bKey=`turn-b-${round}`;
    steps.push(participantStep({input,key:bKey,participantId:"B",role:roles.b,round,
      sequence:round-1,profile:input.participantB,defaultExecutor:"standard",
      dependsOn:[artifactDependency(aKey,"turn","peerTurn")]}));
    episodeTurnKeys.push(bKey);previousB=bKey;

    if (!isCheckpointBoundary(round,input.checkpointEvery,input.rounds)) continue;
    const final=round===input.rounds;
    const synthesisKey=`synthesis-${round}`;
    const dependencies=episodeTurnKeys.map(key=>artifactDependency(key,"turn","turns"));
    if (previousSynthesis) dependencies.push(
      artifactDependency(previousSynthesis,"synthesis","checkpoint"));
    steps.push(synthesisStep({input,key:synthesisKey,round,sequence:synthesisSequence,
      role:synthesisRole,final,dependsOn:dependencies,criteria}));
    synthesisSequence+=1;previousSynthesis=synthesisKey;episodeTurnKeys=[];
  }

  return semanticTaskGraphPlanSchema.parse({
    objective:input.objective,
    acceptanceCriteria:criteria,
    nonGoals:["The dialectic does not mutate the workspace or replace accountable Leader judgment."],
    constraints:[
      `Bound the dialogue to ${input.rounds} rounds and synthesize every ${input.checkpointEvery} round(s).`,
      "Keep participant provider threads cache-stable; append only the newest peer evidence and moderation.",
      "Treat disagreement as information: do not converge merely for social agreement.",
      "Use the synthesis recommendation as advice; the Leader owns continue, reshape, and stop decisions.",
    ],
    assumptions:["Distinct epistemic roles are the minimum diversity mechanism; configured models or executor tiers add runtime diversity when available."],
    questions:[],workPacketId:input.workPacketId??null,
    pattern:{id:"p13.dialectic",version:1},
    problemSignature:{taskKind:"dialectic",goalClarity:"explicit",procedure:"unknown",
      decomposability:"low",evidenceModes:"multiple",alternatives:"several",
      deepUncertainty:false,verificationNeed:"ordinary"},
    steps,terminalStepKeys:[previousSynthesis!],maxActiveAttempts:1,
    ...(input.budgetLimits?{budgetLimits:input.budgetLimits}:{}),
  });
}

function participantStep(args:{input:SubmitDialecticGraphInput;key:string;participantId:"A"|"B";
  role:string;round:number;sequence:number;profile:SubmitDialecticGraphInput["participantA"];
  defaultExecutor:"standard"|"reasoning";dependsOn:Dependency[]}):Step {
  const {input,profile}=args;
  return {
    key:args.key,title:`${args.participantId} · round ${args.round}`,
    objective:[`Reason toward: ${input.objective}`,`Epistemic role: ${args.role}`,
      "Read the newest peer turn and checkpoint artifacts when present. Advance or challenge the reasoning; do not restate the transcript.",
      "Stage one structured turn artifact before reporting completion."].join("\n"),
    acceptanceCriteria:["The turn materially advances or challenges the current reasoning.",
      "Claims, uncertainties, and open questions are explicit in the staged turn artifact."],
    constraints:["Read-only reasoning; do not edit files.",`Dialogue mode: ${input.mode}.`],
    dependsOn:args.dependsOn,contextSelectors:input.contextSelectors,
    inputBindings:{peerTurn:DIALECTIC_TURN_SCHEMA,checkpoint:DIALECTIC_SYNTHESIS_SCHEMA},
    outputSchemas:{turn:DIALECTIC_TURN_SCHEMA},
    executorClass:profile.executorClass??args.defaultExecutor,
    ...(profile.harness?{allowedHarnesses:[profile.harness]}:{}),
    ...(profile.model?{model:profile.model}:{}),
    sessionAffinity:{key:`dialectic:${args.participantId}`,sequence:args.sequence,
      cacheMode:"provider_thread"},
    reasoning:{kind:"dialectic",dialecticId:input.requestId,phase:"turn",
      participantId:args.participantId,role:args.role,round:args.round,final:false},
    ownershipRequest:[],budgetRequest:{},timeoutMs:1_800_000,
    retryPolicy:{maxAttempts:2,backoffMs:1_000,retryableOutcomes:["failed","lost"],jitterMs:0},
    completionMode:"task",verificationRequired:false,failurePolicy:"fail_graph",
    risk:"low",requiresApproval:false,
  };
}

function synthesisStep(args:{input:SubmitDialecticGraphInput;key:string;round:number;
  sequence:number;role:string;final:boolean;dependsOn:Dependency[];criteria:string[]}):Step {
  const profile=args.input.synthesizer;
  return {
    key:args.key,title:`Synthesis checkpoint · round ${args.round}`,
    objective:[`Evaluate the dialectic against this goal: ${args.input.objective}`,
      args.role,"Read every newly supplied turn plus the prior checkpoint when present.",
      "Return a calibrated goalDistance from 0 (goal satisfied with evidence) to 1 (no useful progress). In summary, justify the score using concrete remaining acceptance gaps and supporting or missing evidence; use unresolvedQuestions for unresolved gaps. A low score needs verified coverage, not participant agreement. Compare progress with the prior synthesis when available.",
      args.final?"Produce the best final candidate outcome.":
        "Recommend continue, reshape, or stop and give concise moderation for the Leader."].join("\n"),
    acceptanceCriteria:args.final?args.criteria:[
      "Goal distance, agreements, disagreements, and unresolved questions are explicit.",
      "The recommendation and moderation guidance are concrete enough for a Leader decision.",
    ],
    constraints:["Neutral synthesis; preserve important minority positions.",
      "Do not expose private chain-of-thought; report conclusions and evidence only."],
    dependsOn:args.dependsOn,contextSelectors:args.input.contextSelectors,
    inputBindings:{turns:DIALECTIC_TURN_SCHEMA,checkpoint:DIALECTIC_SYNTHESIS_SCHEMA},
    outputSchemas:{synthesis:DIALECTIC_SYNTHESIS_SCHEMA},
    executorClass:profile.executorClass??"reasoning",
    ...(profile.harness?{allowedHarnesses:[profile.harness]}:{}),
    ...(profile.model?{model:profile.model}:{}),
    sessionAffinity:{key:"dialectic:synthesis",sequence:args.sequence,
      cacheMode:"provider_thread"},
    reasoning:{kind:"dialectic",dialecticId:args.input.requestId,phase:"synthesis",
      participantId:"synthesis",role:args.role,round:args.round,final:args.final},
    ownershipRequest:[],budgetRequest:{},timeoutMs:1_800_000,
    retryPolicy:{maxAttempts:2,backoffMs:1_000,retryableOutcomes:["failed","lost"],jitterMs:0},
    completionMode:"task",verificationRequired:false,failurePolicy:"fail_graph",
    risk:"low",requiresApproval:false,
  };
}

function artifactDependency(stepKey:string,sourceOutput:string,targetInput:string):Dependency {
  return {stepKey,kind:"artifact",sourceOutput,targetInput,satisfactionPolicy:"all_success",
    failurePolicy:"block",optional:false};
}

function humanGate(stepKey:string):Dependency {
  return {stepKey,kind:"human_gate",sourceOutput:null,targetInput:null,
    satisfactionPolicy:"all_success",failurePolicy:"block",optional:false};
}

function isCheckpointBoundary(round:number,every:number,total:number):boolean {
  return round>0&&(round%every===0||round===total);
}

function rolesFor(mode:DialecticMode,a?:string,b?:string):{a:string;b:string} {
  if (mode==="proposer-critic") return {
    a:a?.trim()||"Proposer: construct and iteratively strengthen the most actionable answer.",
    b:b?.trim()||"Critic: search for hidden assumptions, failure modes, missing evidence, and stronger alternatives.",
  };
  if (mode==="debate-synthesis") return {
    a:a?.trim()||"Advocate: make the strongest evidence-aware case for the leading approach.",
    b:b?.trim()||"Challenger: make the strongest alternative case and attack weak causal or factual claims.",
  };
  return {
    a:a?.trim()||"Systems reasoner: optimize coherence, feasibility, and interactions across the whole problem.",
    b:b?.trim()||"Adversarial empiricist: optimize falsifiability, counterexamples, edge cases, and evidence quality.",
  };
}
