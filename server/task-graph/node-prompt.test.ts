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
});
