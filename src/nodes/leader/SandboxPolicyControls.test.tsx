import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SandboxPolicyControls } from "./SandboxPolicyControls.tsx";

describe("SandboxPolicyControls", () => {
  it("edits filesystem, approval, and network axes independently", () => {
    const onChange = vi.fn();
    render(<SandboxPolicyControls onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Sandbox file access"), { target: { value: "read-only" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      filesystemScope: "read-only", approvalPolicy: "on-failure", networkAccess: "disabled",
    }));

    fireEvent.change(screen.getByLabelText("Sandbox network access"), { target: { value: "enabled" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ networkAccess: "enabled" }));
  });

  it("shows the server-resolved posture and unsupported guarantees", () => {
    render(<SandboxPolicyControls onChange={vi.fn()} effective={{
      requested: { filesystemScope: "workspace-write", approvalPolicy: "on-request", networkAccess: "disabled" },
      effective: { filesystemScope: "unmanaged", approvalPolicy: "unmanaged", networkAccess: "unmanaged" },
      unsupported: ["filesystem:workspace-write", "network", "approval"],
    }} />);
    expect(screen.getByText(/Effective: unmanaged/)).toHaveTextContent("unmanaged: filesystem:workspace-write, network, approval");
  });

  it("labels unsupported harness axes as unmanaged instead of editable", () => {
    render(<SandboxPolicyControls onChange={vi.fn()} support={{
      filesystem: [], network: false, approval: false,
    }} />);

    expect(screen.getByLabelText("Sandbox file access")).toHaveTextContent("Unmanaged by harness");
    expect(screen.getByLabelText("Sandbox approval policy")).toHaveTextContent("Unmanaged by harness");
    expect(screen.getByLabelText("Sandbox network access")).toHaveTextContent("Unmanaged by harness");
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
  });
});
