import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ApprovalsScreen } from "./ApprovalsScreen.tsx";
import type { PendingApproval } from "./mobile-approvals.ts";

const approvals: PendingApproval[] = [
  {
    sessionKey: "s-1",
    sessionTitle: "Refactor auth",
    summary: "Extracted token validation and tests.",
    diff: {
      filesChanged: 6,
      insertions: 212,
      deletions: 48,
      files: [],
      commits: ["Extract token validation"],
      branch: "worktree/s-1",
    },
  },
];

describe("ApprovalsScreen", () => {
  it("renders pending approvals", () => {
    render(<ApprovalsScreen approvals={approvals} onOpenReview={() => {}} />);

    const row = screen.getByRole("button", { name: /refactor auth/i });
    expect(within(row).getByText("Extracted token validation and tests.")).toBeInTheDocument();
    expect(within(row).getByText("6 files +212 -48")).toBeInTheDocument();
  });

  it("renders an empty state", () => {
    render(<ApprovalsScreen approvals={[]} onOpenReview={() => {}} />);

    expect(screen.getByText("No sessions are awaiting approval.")).toBeInTheDocument();
  });

  it("opens review when a row is tapped", () => {
    const onOpenReview = vi.fn();
    render(<ApprovalsScreen approvals={approvals} onOpenReview={onOpenReview} />);

    fireEvent.click(screen.getByRole("button", { name: /refactor auth/i }));
    expect(onOpenReview).toHaveBeenCalledWith("s-1");
  });
});
