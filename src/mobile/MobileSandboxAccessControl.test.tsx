import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MobileSandboxAccessControl } from "./MobileSandboxAccessControl.tsx";

describe("MobileSandboxAccessControl", () => {
  it("keeps legacy full host policies Leader-only and explicitly opts Minions in", () => {
    const onChange = vi.fn();
    const policy = { filesystemScope: "unrestricted", approvalPolicy: "never" } as const;
    const { rerender } = render(<MobileSandboxAccessControl policy={policy} onChange={onChange} />);
    expect(screen.getByLabelText("Full Host - Leader Only")).toBeChecked();
    expect(screen.getByLabelText("Full Host - Leader + Minions")).not.toBeChecked();
    fireEvent.click(screen.getByLabelText("Full Host - Leader + Minions"));
    const extended = { ...policy, fullHostScope: "leader-and-minions" } as const;
    expect(onChange).toHaveBeenLastCalledWith(extended);
    rerender(<MobileSandboxAccessControl policy={extended} onChange={onChange} />);
    expect(screen.getByLabelText("Full Host - Leader + Minions")).toBeChecked();
    fireEvent.click(screen.getByLabelText("Read only"));
    expect(onChange).toHaveBeenLastCalledWith({ filesystemScope: "read-only", approvalPolicy: "never" });
  });

  it("disables both full host options for unsupported harnesses", () => {
    render(<MobileSandboxAccessControl onChange={vi.fn()}
      support={{ filesystem: ["workspace-write"], approval: true }} />);
    expect(screen.getByLabelText("Full Host - Leader Only")).toBeDisabled();
    expect(screen.getByLabelText("Full Host - Leader + Minions")).toBeDisabled();
  });
});
