import "./test-helpers.ts";
import { describe, expect, it, vi } from "vitest";
import type { TaskGraphPlanningCoordinator } from "./planning-coordinator.ts";
import { TaskGraphConflictError, TaskGraphValidationError } from "./errors.ts";
import { SemanticGraphDocumentDraft } from "./graph-document.ts";
import { createTaskGraphPlanningTools } from "./planning-tools.ts";

const header = { objective: "Ship graph tools", acceptanceCriteria: ["Focused tests pass"] };
const node = (key: string, contextSelectors: string[] = []) => ({
  key,
  title: `Step ${key}`,
  objective: `Complete ${key}`,
  acceptanceCriteria: [`${key} is complete`],
  contextSelectors,
});

describe("semantic graph document draft", () => {
  it("applies defaults and advances exactly one revision for each accepted mutation", () => {
    const draft = new SemanticGraphDocumentDraft();

    expect(draft.initialize(header, 0)).toMatchObject({
      documentRevision: 1,
      objective: "Ship graph tools",
      nodes: [],
      edges: [],
    });
    expect(draft.upsertNode(node("build", ["repo:server/task-graph"]), 1))
      .toMatchObject({ documentRevision: 2 });
    expect(draft.upsertNode(node("verify"), 2)).toMatchObject({ documentRevision: 3 });
    expect(draft.upsertEdge({ sourceStepKey: "build", targetStepKey: "verify" }, 3))
      .toMatchObject({ documentRevision: 4 });

    expect(draft.inspect("compact")).toEqual({
      documentRevision: 4,
      objective: "Ship graph tools",
      acceptanceCriteria: ["Focused tests pass"],
      nodes: [
        { key: "build", title: "Step build", dependsOn: [],
          contextSelectors: ["repo:server/task-graph"] },
        { key: "verify", title: "Step verify", dependsOn: ["build"], contextSelectors: [] },
      ],
      edges: [{ sourceStepKey: "build", targetStepKey: "verify", kind: "control",
        sourceOutput:null,targetInput:null,optional:false,failurePolicy:"block" }],
    });
    expect(draft.inspect("full")).toMatchObject({
      documentRevision: 4,
      plan: {
        nonGoals: [], constraints: [], assumptions: [], questions: [], maxActiveAttempts: 4,
        steps: [{ key: "build", executorClass: "standard" }, {
          key: "verify", dependsOn: [{ stepKey: "build", kind: "control", optional: false }],
        }],
      },
    });
  });

  it("preserves pattern and bounded-episode metadata in the assembled plan",()=>{
    const draft=new SemanticGraphDocumentDraft();
    draft.initialize({...header,pattern:{id:"p01.pipeline",version:1},
      problemSignature:{taskKind:"delivery",procedure:"known"},
      iteration:{strategy:"single_episode",episode:1}},0);
    draft.upsertNode(node("build"),1);
    expect(draft.inspect("full")).toMatchObject({plan:{
      pattern:{id:"p01.pipeline",version:1},
      problemSignature:{taskKind:"delivery",procedure:"known"},
      iteration:{strategy:"single_episode",episode:1},
    }});
  });

  it("returns the latest draft on a stale revision and preserves it", () => {
    const draft = new SemanticGraphDocumentDraft();
    draft.initialize(header, 0);
    draft.upsertNode(node("build"), 1);

    expect(() => draft.upsertNode(node("stale"), 1)).toThrow(TaskGraphConflictError);
    expect(draft.inspect("compact")).toMatchObject({
      documentRevision: 2,
      nodes: [{ key: "build" }],
    });
  });

  it("rejects removals and replacements that would leave invalid edge references", () => {
    const draft = new SemanticGraphDocumentDraft();
    draft.initialize(header, 0);
    draft.upsertNode({ ...node("producer"), outputSchemas: { report: { type: "string" } } }, 1);
    draft.upsertNode({ ...node("consumer"), inputBindings: { report: { type: "string" } } }, 2);
    draft.upsertEdge({ sourceStepKey: "producer", targetStepKey: "consumer",
      kind: "artifact", sourceOutput: "report", targetInput: "report" }, 3);

    expect(() => draft.removeNode("producer", 4)).toThrow(TaskGraphValidationError);
    expect(() => draft.upsertNode(node("producer"), 4)).toThrow(TaskGraphValidationError);
    expect(draft.inspect("compact")).toMatchObject({ documentRevision: 4, nodes: [{
      key: "consumer",
    }, { key: "producer" }] });
    expect(draft.removeEdge({sourceStepKey:"producer",targetStepKey:"consumer",kind:"artifact",
      sourceOutput:"report",targetInput:"report"},4)).toMatchObject({ documentRevision: 5 });
    expect(draft.removeNode("producer", 5)).toMatchObject({ documentRevision: 6 });
  });

  it("identifies the exact missing artifact declaration", () => {
    const draft = new SemanticGraphDocumentDraft();
    draft.initialize(header, 0);
    draft.upsertNode(node("producer"), 1);
    draft.upsertNode({ ...node("consumer"), inputBindings: { report: { type: "string" } } }, 2);

    expect(() => draft.upsertEdge({ sourceStepKey: "producer", targetStepKey: "consumer",
      kind: "artifact", sourceOutput: "report", targetInput: "report" }, 3))
      .toThrow('sourceOutput "report" is not declared in producer.outputSchemas');
    expect(draft.inspect("compact")).toMatchObject({ documentRevision: 3, edges: [] });
  });

  it("rejects artifact fields on ordering-only edges", () => {
    const draft = new SemanticGraphDocumentDraft();
    draft.initialize(header, 0);
    draft.upsertNode(node("first"), 1);
    draft.upsertNode(node("second"), 2);

    expect(() => draft.upsertEdge({ sourceStepKey: "first", targetStepKey: "second",
      kind: "control", sourceOutput: "report", targetInput: "report" }, 3))
      .toThrow("cannot declare artifact bindings");
  });

  it("preserves distinct artifact bindings between the same pair of nodes",()=>{
    const draft=new SemanticGraphDocumentDraft();
    draft.initialize(header,0);
    draft.upsertNode({...node("producer"),outputSchemas:{report:{type:"string"},log:{type:"string"}}},1);
    draft.upsertNode({...node("consumer"),inputBindings:{report:{type:"string"},log:{type:"string"}}},2);
    draft.upsertEdge({sourceStepKey:"producer",targetStepKey:"consumer",kind:"artifact",
      sourceOutput:"report",targetInput:"report"},3);
    draft.upsertEdge({sourceStepKey:"producer",targetStepKey:"consumer",kind:"artifact",
      sourceOutput:"log",targetInput:"log"},4);

    expect(draft.inspect("full")).toMatchObject({plan:{steps:[{key:"consumer",dependsOn:[
      {stepKey:"producer",sourceOutput:"log",targetInput:"log"},
      {stepKey:"producer",sourceOutput:"report",targetInput:"report"},
    ]},{}]}});
    expect(draft.removeEdge({sourceStepKey:"producer",targetStepKey:"consumer",kind:"artifact",
      sourceOutput:"log",targetInput:"log"},5)).toMatchObject({documentRevision:6,edges:[
      expect.objectContaining({sourceOutput:"report",targetInput:"report"}),
    ]});
  });
});

describe("graph document planning tools", () => {
  it("parses the assembled semantic plan and submits through the coordinator", async () => {
    const submit = vi.fn(async () => ({ state: "ready", canStart: false,
      questions: [], autoStartEligible: true }));
    const coordinator = { submit } as unknown as TaskGraphPlanningCoordinator;
    const tools = createTaskGraphPlanningTools({ coordinator, workItemId: "work",
      primaryRunKey: "primary", mode: "plan", leaderSessionKey: "leader" });
    const call = async (name: string, input: unknown) => {
      const result = await tools.find((tool) => tool.name === name)!.handler(input);
      return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    };

    await call("initialize_graph_document", { expectedDocumentRevision: 0, plan: header });
    await call("upsert_graph_node", { expectedDocumentRevision: 1, node: node("build") });
    const result = await call("submit_graph_document", {
      expectedDocumentRevision: 2,
      requestId: "submit-document",
      baseProposalRevision: null,
    });

    expect(result.documentRevision).toBe(2);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: "work",
      primaryRunKey: "primary",
      requestId: "submit-document",
      plan: expect.objectContaining({
        objective: "Ship graph tools",
        nonGoals: [],
        maxActiveAttempts: 4,
        steps: [expect.objectContaining({ key: "build", dependsOn: [] })],
      }),
    }));
  });
});
