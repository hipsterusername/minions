import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkItemSnapshot } from "../../../shared/work-item-contracts.ts";
import { ConfigFooter } from "./ConfigFooter.tsx";
import { LEADER_DEFAULT_DATA, type LeaderData } from "./types.ts";

function snapshot(changeMode: "live" | "worktree"): WorkItemSnapshot {
  return {
    id: "work-1", projectId: "project", projectPath: "/repo", title: "Task",
    lifecycle: { runtimeState: "inactive", outcome: "completed", resolution: "open",
      changeMode, integrationState: changeMode === "live" ? "live_clean" : "worktree_active",
      lifecycleRevision: 1 },
    waitKind: null, currentRunKey: "run-1", iteration: 1,
    workflowColumnId: "in-progress", workflowRank: "a", workflowRevision: 1,
    card: { description: "", subtasks: [], context: "", priority: "medium", model: "",
      permissionMode: "auto", worktreeIsolation: changeMode === "worktree", skillIds: [],
      skillValues: {}, linkedContextNodeIds: [] },
    lastTransitionAt: 1, createdAt: 1, updatedAt: 1,
  };
}

function renderFooter(data: Partial<LeaderData>) {
  return render(<ConfigFooter data={{ ...LEADER_DEFAULT_DATA, ...data }}
    onUpdateData={vi.fn()} />);
}

describe("ConfigFooter change mode", () => {
  it("calls direct-working-tree mode Live, not Shared", () => {
    renderFooter({ worktreeIsolation: false });
    expect(screen.getByText(/Live/)).toBeInTheDocument();
    expect(screen.queryByText(/shared/i)).toBeNull();
  });

  it("uses the canonical mode when the legacy setup flag is stale", () => {
    const view = renderFooter({ worktreeIsolation: true, workItemSnapshot: snapshot("live") });
    expect(screen.getByText(/Live/)).toBeInTheDocument();
    view.rerender(<ConfigFooter data={{ ...LEADER_DEFAULT_DATA, worktreeIsolation: false,
      workItemSnapshot: snapshot("worktree") }} onUpdateData={vi.fn()} />);
    expect(screen.getByText(/Worktree/)).toBeInTheDocument();
  });
});
