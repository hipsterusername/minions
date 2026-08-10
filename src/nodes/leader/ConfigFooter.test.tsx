import { fireEvent, render, screen } from "@testing-library/react";
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

  it("labels the process sandbox separately from Git change mode", () => {
    renderFooter({ worktreeIsolation: true, sandboxPolicy: {
      filesystemScope: "read-only", approvalPolicy: "always",
    } });
    expect(screen.getByText("Sandbox: read-only")).toBeInTheDocument();
    expect(screen.getByText(/Worktree/)).toBeInTheDocument();
  });
});

describe("ConfigFooter change-mode selector", () => {
  function expandFooter() {
    // The collapsed summary row toggles the expanded config on click.
    fireEvent.click(screen.getByText(/Live/));
  }

  it("shows both options as a segmented toggle with the active one pressed", () => {
    renderFooter({ worktreeIsolation: false });
    expandFooter();
    const live = screen.getByRole("button", { name: /Live/ });
    const worktree = screen.getByRole("button", { name: /Worktree/ });
    expect(live).toHaveAttribute("aria-pressed", "true");
    expect(worktree).toHaveAttribute("aria-pressed", "false");
  });

  it("switches to Worktree mode when the Worktree segment is clicked", () => {
    const onUpdateData = vi.fn();
    render(<ConfigFooter data={{ ...LEADER_DEFAULT_DATA, worktreeIsolation: false }}
      onUpdateData={onUpdateData} />);
    fireEvent.click(screen.getByText(/Live/));
    fireEvent.click(screen.getByRole("button", { name: /Worktree/ }));
    expect(onUpdateData).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeIsolation: true }),
    );
  });

  it("locks the selector and shows a fixed indicator once a session starts", () => {
    const onUpdateData = vi.fn();
    render(<ConfigFooter data={{ ...LEADER_DEFAULT_DATA, worktreeIsolation: false,
      sessionKey: "run-1" }} onUpdateData={onUpdateData} />);
    fireEvent.click(screen.getByText(/Live/));
    const worktree = screen.getByRole("button", { name: /Worktree/ });
    expect(worktree).toBeDisabled();
    fireEvent.click(worktree);
    expect(onUpdateData).not.toHaveBeenCalled();
    expect(screen.getByText(/fixed/)).toBeInTheDocument();
  });
});
