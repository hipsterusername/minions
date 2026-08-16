import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { taskGraphPlanSnapshotViewSchema } from "../../shared/task-graph-planning-contracts.ts";
import { GraphPlanProposalCard, GraphPlanProposalDialog } from "./GraphPlanProposal.tsx";

function snapshot(input: { canStart: boolean; error?: string | null; reviews?: boolean }) {
  return taskGraphPlanSnapshotViewSchema.parse({
    proposalId: "proposal", workItemId: "work", primaryRunKey: "primary",
    revision: 1, proposalRevision: 1, baseProposalRevision: null, state: "ready", mode: "plan",
    objective: "Repair graph planning", acceptanceCriteria: ["Verified"], assumptions: [],
    questions: [], workPacketId: "packet", steps: [{ key: "build", nodeId: "node",
      title: "Build", objective: "Build it", acceptanceCriteria: ["Passes"], dependsOn: [],
      contextSelectors: [], executorClass: "standard", risk: "low", requiresApproval: false }],
    materializedRevisionId: "revision", graphRunId: null, sourceSnapshotId: "source",
    autoStartEligible: false, canStart: input.canStart,
    reviewRequirements: input.reviews ? [{ gateId: "gate.execution",
      name: "Execution graph runtime", reason: "Matched packet scope" }] : [],
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

  it("shows detailed deferred reviews in the proposal dialog", () => {
    render(<GraphPlanProposalDialog snapshot={snapshot({ canStart: true, reviews: true })}
      actions={actions()} onClose={vi.fn()} />);

    expect(screen.getByText(/Integration remains blocked until these reviews pass or are waived/))
      .toBeInTheDocument();
    expect(screen.getByText(/Matched packet scope/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start work" })).toBeEnabled();
  });
});
