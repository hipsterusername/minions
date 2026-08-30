import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { taskGraphPlanSnapshotViewSchema } from "../../shared/task-graph-planning-contracts.ts";
import { GraphPlanProposalCard, GraphPlanProposalDialog } from "./GraphPlanProposal.tsx";

function snapshot(input: { canStart: boolean; error?: string | null; reviews?: boolean;
  warnings?:string[];state?: "ready" | "failed";pattern?:boolean;successor?:boolean }) {
  return taskGraphPlanSnapshotViewSchema.parse({
    proposalId: "proposal", workItemId: "work", primaryRunKey: "primary",
    revision: 1, proposalRevision: 1, baseProposalRevision: null, state: input.state ?? "ready", mode: "plan",
    objective: "Repair graph planning", acceptanceCriteria: ["Verified"], assumptions: [],
    questions: [], workPacketId: "packet", steps: [{ key: "build", nodeId: "node",
      title: "Build", objective: "Build it", acceptanceCriteria: ["Passes"], dependsOn: [],
      contextSelectors: [], inputBindings:{},outputSchemas:{result:{type:"object",required:["ok"]}},
      outputExamples:{result:{ok:{}}},executorClass: "standard", risk: "low", requiresApproval: false }],
    materializedRevisionId: "revision", graphRunId: null, sourceSnapshotId: "source",
    pattern:input.pattern?{id:"p07.independent_verification",version:1}:null,
    patternRecommendation:{id:"p07.independent_verification",version:1,
      label:"Independent verification",rationale:"The output is consequential.",
      source:"problem_signature"},
    patternTemplate:{id:"p07.independent_verification",version:1,
      label:"Independent verification",topology:"Producer -> verified artifact -> Consumer",
      requiredArtifacts:["VerificationVerdict"],safetyChecks:["Verifier is independent."]},
    iteration:input.successor?{strategy:"successor_revision",episode:2,
      reason:"The first verifier found a defect",evidenceRefs:["artifact:verdict"],
      stopCondition:"The corrected artifact passes verification"}:null,
    autoStartEligible: false, canStart: input.canStart,
    reviewRequirements: input.reviews ? [{ gateId: "gate.execution",
      name: "Execution graph runtime", reason: "Matched packet scope" }] : [],
    topologyWarnings:input.warnings??[],
    error: input.error ?? null, updatedAt: 1,
  });
}

function actions(onStart = vi.fn()) {
  return { controlsEnabled: true, stale: false, onStart, onReject: vi.fn(), onOpen: vi.fn() };
}

describe("GraphPlanProposal", () => {
  it("enables Start while exposing reviews deferred until integration", () => {
    const onStart = vi.fn();
    render(<GraphPlanProposalCard snapshot={snapshot({ canStart: true, reviews: true })}
      actions={actions(onStart)} />);

    expect(screen.getByText("Review required before integration")).toBeInTheDocument();
    expect(screen.getByText("Execution graph runtime")).toBeInTheDocument();
    const start = screen.getByRole("button", { name: "Start" });
    expect(start).toBeEnabled();
    fireEvent.click(start);
    expect(onStart).toHaveBeenCalledOnce();
  });

  it("keeps genuine start blockers visible and disabled", () => {
    render(<GraphPlanProposalCard snapshot={snapshot({ canStart: false,
      error: "Work Packet freshness checks are stale and blocking." })} actions={actions()} />);

    expect(screen.getByText("Work Packet freshness checks are stale and blocking."))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  });

  it("keeps failed plan cards compact while retaining their reason and actions", () => {
    const onAdjust = vi.fn();
    const onOpen = vi.fn();
    const error = "Planning failed because the Work Packet source snapshot changed while validation was running. ".repeat(3);
    render(<GraphPlanProposalCard snapshot={snapshot({ canStart: false, state: "failed",
      error, reviews: true })} actions={{ ...actions(), onAdjust, onOpen }} />);

    expect(screen.getByText("Plan failed")).toBeInTheDocument();
    expect(screen.getByText(/Planning failed because the Work Packet source snapshot changed/))
      .toHaveTextContent("…");
    expect(screen.queryByText("Outcome")).not.toBeInTheDocument();
    expect(screen.queryByText("Build")).not.toBeInTheDocument();
    expect(screen.queryByText("1 steps")).not.toBeInTheDocument();
    expect(screen.queryByText("Review required before integration")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Adjust" }));
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(onAdjust).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("keeps failed plan details available in the unchanged proposal dialog", () => {
    render(<GraphPlanProposalDialog snapshot={snapshot({ canStart: false, state: "failed",
      error: "The planner could not validate the Work Packet.", reviews: true })}
      actions={actions()} onClose={vi.fn()} />);

    expect(screen.getByText("Build")).toBeInTheDocument();
    expect(screen.getByText("The planner could not validate the Work Packet.")).toBeInTheDocument();
    expect(screen.getByText(/Matched packet scope/)).toBeInTheDocument();
  });

  it("shows detailed deferred reviews in the proposal dialog", () => {
    render(<GraphPlanProposalDialog snapshot={snapshot({ canStart: true, reviews: true })}
      actions={actions()} onClose={vi.fn()} />);

    expect(screen.getByText(/Integration remains blocked until these reviews pass or are waived/))
      .toBeInTheDocument();
    expect(screen.getByText(/Matched packet scope/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start work" })).toBeEnabled();
    expect(screen.getByText("Artifact contracts (1)")).toBeInTheDocument();
    expect(screen.getByText("Exact JSON Schema")).toBeInTheDocument();
    expect(screen.getByText("Accepted example")).toBeInTheDocument();
  });

  it("shows acceptance-coverage and verifier topology warnings before execution",()=>{
    render(<GraphPlanProposalDialog snapshot={snapshot({canStart:true,warnings:[
      "The mission promises independent verification but no verification-mode step is declared.",
    ]})} actions={actions()} onClose={vi.fn()} />);
    expect(screen.getByText("Topology preflight")).toBeInTheDocument();
    expect(screen.getByText(/promises independent verification/)).toBeInTheDocument();
  });

  it("shows pattern provenance, router rationale, and bounded successor metadata",()=>{
    render(<GraphPlanProposalDialog snapshot={snapshot({canStart:true,pattern:true,successor:true})}
      actions={actions()} onClose={vi.fn()} />);
    expect(screen.getByText("p07.independent_verification · v1")).toBeInTheDocument();
    expect(screen.getByText("The output is consequential.")).toBeInTheDocument();
    expect(screen.getByText(/Topology: Producer -> verified artifact -> Consumer/))
      .toBeInTheDocument();
    expect(screen.getByText(/Artifact vocabulary: VerificationVerdict/)).toBeInTheDocument();
    expect(screen.getByText("Successor episode 2")).toBeInTheDocument();
    expect(screen.getByText(/Stop when: The corrected artifact passes verification/))
      .toBeInTheDocument();
  });

  it("makes a direct-execution recommendation visible on the compact card",()=>{
    const value=snapshot({canStart:false});
    value.patternRecommendation={id:"p00.direct",version:1,label:"Direct execution",
      rationale:"One bounded step has no meaningful graph handoff.",source:"expanded_topology"};
    render(<GraphPlanProposalCard snapshot={value} actions={actions()} />);
    expect(screen.getByText("Router recommends direct execution for this bounded unit."))
      .toBeInTheDocument();
  });
});
