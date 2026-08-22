import "./test-helpers.ts";
import { describe,expect,it } from "vitest";
import type { AgentHarness } from "../harness/types.ts";
import type { TaskNode } from "../../shared/task-graph-contracts.ts";
import { TaskGraphValidationError } from "./errors.ts";
import { sandboxPolicyForTaskGraphNode,validateTaskGraphNodePolicy } from "./execution-policy.ts";

const node=(extra:Partial<TaskNode>={}):TaskNode=>({id:"node",title:"Node",objective:"Do it",
  inputBindings:{},outputSchemas:{},constraints:[],acceptanceCriteria:[],executorClass:"standard",
  allowedHarnesses:["test"],allowedTools:[],ownershipRequest:[],budgetRequest:{},timeoutMs:1_000,
  retryPolicy:{maxAttempts:1,backoffMs:0,retryableOutcomes:["failed"],jitterMs:0},
  verificationRequired:false,failurePolicy:"fail_graph",expansionPolicy:null,...extra});
const harness={name:"test",builtInTools:["Read"],capabilities:{
  mutationInterception:"observe_only",
}} as AgentHarness;

describe("task graph execution policy",()=>{
  it("accepts registered harness tools and mandatory graph tools",()=>{
    expect(()=>validateTaskGraphNodePolicy(node({allowedTools:["Read",
      "mcp__task-graph__read_input_artifact","mcp__task-graph__stage_output_artifact"]}),
    ()=>harness)).not.toThrow();
  });

  it("rejects unknown harnesses and unavailable tools during revision preflight",()=>{
    expect(()=>validateTaskGraphNodePolicy(node(),()=>{throw new Error("missing");}))
      .toThrow(TaskGraphValidationError);
    expect(()=>validateTaskGraphNodePolicy(node({allowedTools:["Write"]}),()=>harness))
      .toThrow("unavailable on harness test: Write");
  });

  it("inherits native shell/filesystem access instead of accepting guessed aliases",()=>{
    const codex={...harness,name:"codex",builtInTools:[],capabilities:{
      ...harness.capabilities,builtInFilesystem:true,
      sandboxEnforcement:{filesystem:["read-only","workspace-write"],approval:true},
    }} as AgentHarness;
    expect(()=>validateTaskGraphNodePolicy(node({allowedTools:[]}),()=>codex)).not.toThrow();
    expect(()=>validateTaskGraphNodePolicy(node({allowedTools:["shell"]}),()=>codex))
      .toThrow("omit allowedTools to inherit harness-native shell/filesystem access");
  });

  it("rejects write ownership that the selected harness cannot enforce",()=>{
    const writer=node({ownershipRequest:[{scope:"path",mode:"write",normalizedValue:"server"}]});
    expect(()=>validateTaskGraphNodePolicy(writer,()=>harness))
      .toThrow("requires enforced writes unavailable on harness test");
    const enforcing={...harness,capabilities:{mutationInterception:"complete"}} as AgentHarness;
    expect(()=>validateTaskGraphNodePolicy(writer,()=>enforcing)).not.toThrow();
    expect(()=>validateTaskGraphNodePolicy(node({ownershipRequest:[{
      scope:"symbol",mode:"write",normalizedValue:"run",
    }]}),()=>enforcing)).toThrow("unsupported symbol write ownership");
  });

  it("requires explicit read-only sandbox enforcement for built-in filesystem harnesses",()=>{
    const codex={...harness,name:"codex",capabilities:{...harness.capabilities,builtInFilesystem:true,
      sandboxEnforcement:{filesystem:["read-only","workspace-write"],approval:true}}} as AgentHarness;
    const outputProducer=node({outputSchemas:{result:{type:"object"}},ownershipRequest:[]});
    expect(()=>validateTaskGraphNodePolicy(outputProducer,()=>codex)).not.toThrow();
    expect(sandboxPolicyForTaskGraphNode(outputProducer,()=>codex)).toEqual({
      filesystemScope:"read-only",approvalPolicy:"never",
    });
    const writer=node({ownershipRequest:[{
      scope:"path",mode:"write",normalizedValue:"server",
    }]});
    expect(()=>validateTaskGraphNodePolicy(writer,()=>codex)).not.toThrow();
    expect(sandboxPolicyForTaskGraphNode(writer,()=>codex)).toEqual({
      filesystemScope:"workspace-write",approvalPolicy:"never",
    });
    for (const incomplete of [
      {...harness,capabilities:{...harness.capabilities,builtInFilesystem:true}},
      {...codex,capabilities:{...codex.capabilities,sandboxEnforcement:{filesystem:["workspace-write"],approval:true}}},
      {...codex,capabilities:{...codex.capabilities,sandboxEnforcement:{filesystem:["read-only"],approval:false}}},
    ] as AgentHarness[]) {
      expect(()=>validateTaskGraphNodePolicy(node(),()=>incomplete))
        .toThrow("requires enforced read-only filesystem and never-approval sandboxing");
    }
    for (const incomplete of [
      harness,
      {...codex,capabilities:{...codex.capabilities,sandboxEnforcement:{filesystem:["read-only"],approval:true}}},
      {...codex,capabilities:{...codex.capabilities,sandboxEnforcement:{filesystem:["workspace-write"],approval:false}}},
    ] as AgentHarness[]) {
      expect(()=>validateTaskGraphNodePolicy(writer,()=>incomplete))
        .toThrow(TaskGraphValidationError);
    }
  });

  it("does not claim a provider sandbox for coordinated or filesystem-free harnesses",()=>{
    const complete={...harness,capabilities:{...harness.capabilities,mutationInterception:"complete",
      builtInFilesystem:true}} as AgentHarness;
    const echo={...harness,capabilities:{...harness.capabilities,builtInFilesystem:false}} as AgentHarness;
    expect(sandboxPolicyForTaskGraphNode(node(),()=>complete)).toBeUndefined();
    expect(sandboxPolicyForTaskGraphNode(node(),()=>echo)).toBeUndefined();
    expect(()=>validateTaskGraphNodePolicy(node(),()=>echo)).not.toThrow();
  });
});
