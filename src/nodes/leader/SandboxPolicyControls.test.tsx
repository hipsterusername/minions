import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SandboxPolicyControls } from "./SandboxPolicyControls.tsx";

describe("SandboxPolicyControls", () => {
  it("edits filesystem and approval axes independently", () => {
    const onChange = vi.fn();
    render(<SandboxPolicyControls onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Sandbox file access"), { target: { value: "read-only" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      filesystemScope: "read-only", approvalPolicy: "on-failure",
    }));
  });

  it("explains each sandbox axis on hover", () => {
    render(<SandboxPolicyControls onChange={vi.fn()} />);

    expect(screen.getByLabelText("About sandbox file access")).toHaveAttribute(
      "title",
      expect.stringContaining("Workspace write limits edits"),
    );
    expect(screen.getByLabelText("About sandbox approval policy")).toHaveAttribute(
      "title",
      expect.stringContaining("guarded actions"),
    );
  });

  it("shows the server-resolved posture and unsupported guarantees", () => {
    render(<SandboxPolicyControls onChange={vi.fn()} effective={{
      requested: { filesystemScope: "workspace-write", approvalPolicy: "on-request" },
      effective: { filesystemScope: "unmanaged", approvalPolicy: "unmanaged" },
      unsupported: ["filesystem:workspace-write", "approval"],
    }} />);
    expect(screen.getByText(/Effective: unmanaged/)).toHaveTextContent("unmanaged: filesystem:workspace-write, approval");
  });

  it("labels unsupported harness axes as unmanaged instead of editable", () => {
    render(<SandboxPolicyControls onChange={vi.fn()} support={{
      filesystem: [], approval: false,
    }} />);

    expect(screen.getByLabelText("Sandbox file access")).toHaveTextContent("Unmanaged by harness");
    expect(screen.getByLabelText("Sandbox approval policy")).toHaveTextContent("Unmanaged by harness");
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
  });
});
