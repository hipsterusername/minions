import {describe,expect,it} from "vitest";
import type {GraphRevisionInput,TaskNode} from "../../shared/task-graph-contracts.ts";
import {renderTaskGraphNodePrompt} from "./node-prompt.ts";

function node(completionMode?:"task"|"verification"):TaskNode {
  return {id:"node",title:"Check",objective:"Check the result",inputBindings:{},outputSchemas:{},
    constraints:[],acceptanceCriteria:["The result is correct"],executorClass:"reasoning",
    allowedHarnesses:["codex"],allowedTools:[],ownershipRequest:[],budgetRequest:{},timeoutMs:1_000,
    retryPolicy:{maxAttempts:1,backoffMs:0,retryableOutcomes:[],jitterMs:0},completionMode,
    verificationRequired:false,failurePolicy:"fail_graph",expansionPolicy:null};
}

function revision(task:TaskNode):GraphRevisionInput {
  return {definitionId:"definition",revisionId:"revision",workItemId:"work",workspaceId:"workspace",
    objective:"Ship",acceptanceCriteria:["done"],nonGoals:[],constraints:[],terminalNodeIds:[task.id],
    nodes:[task],edges:[],maxActiveAttempts:1};
}

describe("renderTaskGraphNodePrompt",()=>{
  it("requires a JSON-only verdict and states that only passed satisfies verification mode",()=>{
    const task=node("verification");
    const prompt=renderTaskGraphNodePrompt(revision(task),task,"attempt",1,"source",[],[],[]);
    expect(prompt).toContain("This is a verification-mode step");
    expect(prompt).toContain("Your final report must be JSON only");
    expect(prompt).toContain('Only result="passed" satisfies this node');
  });

  it("keeps normal task completion guidance unchanged",()=>{
    const task=node("task");
    const prompt=renderTaskGraphNodePrompt(revision(task),task,"attempt",1,"source",[],[],[]);
    expect(prompt).not.toContain("verification-mode step");
    expect(prompt).toContain("provide a concise evidence-backed final report");
  });

  it("freezes exact output contracts and an accepted staging example into the prompt",()=>{
    const task={...node("task"),outputSchemas:{audit:{type:"object",required:["findings"],
      properties:{findings:{type:"array",items:{type:"string"}}}}}};
    const prompt=renderTaskGraphNodePrompt(revision(task),task,"attempt",1,"source",[],[],[]);
    expect(prompt).toContain("Artifact output contracts (frozen before execution)");
    expect(prompt).toContain('Exact JSON Schema: {"type":"object","required":["findings"]');
    expect(prompt).toContain('Accepted example: {"findings":["string"]}');
    expect(prompt).toContain('"outputName":"audit"');
  });

  it("reuses a prior final report for a staging-only recovery attempt",()=>{
    const task={...node("task"),outputSchemas:{audit:{type:"object"}}};
    const prompt=renderTaskGraphNodePrompt(revision(task),task,"attempt-2",2,"source",[],[],[],{
      attemptId:"attempt-1",finalReport:"Completed audit reasoning",
      stagingFailure:{missingOutputs:["audit"],stagedOutputs:[]},
    });
    expect(prompt).toContain("Do not repeat completed analysis");
    expect(prompt).toContain("Missing outputs: audit");
    expect(prompt).toContain("Completed audit reasoning");
  });

  it("includes Leader moderation supplied at a dialectic checkpoint",()=>{
    const task=node("task");
    const prompt=renderTaskGraphNodePrompt(revision(task),task,"attempt",1,"source",[],[],[],
      null,["Continue, but test the rollback assumptions before converging."]);
    expect(prompt).toContain("Leader moderation input");
    expect(prompt).toContain("test the rollback assumptions");
  });
});
