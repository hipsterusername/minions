import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GateStrip, type MergeGateVerdict } from "./GateStrip.tsx";

function verdict(overrides: Partial<MergeGateVerdict> = {}): MergeGateVerdict {
  return {
    allowed: false,
    mode: "enforced",
    gates: [
      {
        id: "passed",
        name: "Tests",
        status: "passed",
        reason: "Verification passed.",
      },
      {
        id: "pending",
        name: "Review",
        status: "required_pending",
        reason: "Reconciliation has not run.",
      },
      {
        id: "failed",
        name: "Security",
        status: "failed",
        reason: "Required verification failed.",
      },
      {
        id: "waived",
        name: "Docs",
        status: "waived",
        reason: "Waived by lead.",
      },
      {
        id: "not-required",
        name: "Mobile",
        status: "not_required",
        reason: "No changed files match this gate.",
      },
    ],
    ...overrides,
  };
}

describe("GateStrip", () => {
  it("renders honest status chips and hides not-required gates", () => {
    render(<GateStrip gates={verdict()} sessionKey="leader-1" socketSend={vi.fn()} />);

    expect(screen.getByRole("button", { name: /Tests Passed/ }).querySelector('svg[data-minions-icon="check"]')).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("button", { name: /Review Pending/ }).querySelector('svg[data-minions-icon="warning"]')).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("button", { name: /Security Failed/ }).querySelector('svg[data-minions-icon="close"]')).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("button", { name: /Docs Waived/ }).querySelector('svg[data-minions-icon="waived"]')).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByText("Mobile")).not.toBeInTheDocument();
  });

  it("expands a chip to show reason and verification provenance", () => {
    render(<GateStrip gates={verdict()} sessionKey="leader-1" socketSend={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /Review Pending/ }));

    const strip = screen.getByRole("region", { name: "Review gates" });
    expect(within(strip).getByText("Reconciliation has not run.")).toBeInTheDocument();
    expect(within(strip).getByText("pending")).toBeInTheDocument();
  });

  it("sends waive_review_gate with the session, gate, and human reason", async () => {
    const send = vi.fn();
    render(<GateStrip gates={verdict()} sessionKey="leader-1" socketSend={send} />);

    fireEvent.click(screen.getByRole("button", { name: /Review Pending/ }));
    fireEvent.change(screen.getByLabelText("Waiver reason for Review"), {
      target: { value: "Lead accepts the documented risk." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Waive" }));

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith({
        type: "waive_review_gate",
        sessionKey: "leader-1",
        gateId: "pending",
        reason: "Lead accepts the documented risk.",
      });
    });
  });

  it("disables waive controls in advisory mode", async () => {
    const send = vi.fn();
    render(
      <GateStrip
        gates={verdict({ mode: "advisory" })}
        sessionKey="leader-1"
        socketSend={send}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Security Failed/ }));
    const input = screen.getByLabelText("Waiver reason for Security");
    const waive = screen.getByRole("button", { name: "Waive" });

    expect(input).toBeDisabled();
    expect(waive).toBeDisabled();
    expect(screen.getByText("Advisory mode: gates are informational.")).toBeInTheDocument();
    await waitFor(() => expect(send).not.toHaveBeenCalled());
  });

  it("renders nothing when gates are null or off", () => {
    const { rerender } = render(
      <GateStrip gates={null} sessionKey="leader-1" socketSend={vi.fn()} />,
    );

    expect(screen.queryByRole("region", { name: "Review gates" })).not.toBeInTheDocument();

    rerender(
      <GateStrip
        gates={verdict({ mode: "off", gates: [] })}
        sessionKey="leader-1"
        socketSend={vi.fn()}
      />,
    );
    expect(screen.queryByRole("region", { name: "Review gates" })).not.toBeInTheDocument();
  });
});
