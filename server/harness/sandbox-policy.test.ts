import { describe, expect, it } from "vitest";
import { resolveHarnessSandboxPolicy } from "./sandbox-policy.ts";

const complete = {
  filesystem: ["read-only", "workspace-write", "unrestricted"] as const,
  network: true,
  approval: true,
};

describe("resolveHarnessSandboxPolicy", () => {
  it("defaults worktree runs to workspace-write rooted at their execution cwd", () => {
    expect(resolveHarnessSandboxPolicy({ worktreeScoped: true, support: complete }))
      .toEqual({
        requested: { filesystemScope: "workspace-write", networkAccess: "disabled", approvalPolicy: "on-failure" },
        effective: { filesystemScope: "workspace-write", networkAccess: "disabled", approvalPolicy: "on-failure" },
        unsupported: [],
      });
  });

  it("defaults an authorized source root to workspace-write", () => {
    expect(resolveHarnessSandboxPolicy({ worktreeScoped: false, support: complete }).requested.filesystemScope)
      .toBe("workspace-write");
  });

  it("requires an explicit unrestricted policy for full host access", () => {
    const result = resolveHarnessSandboxPolicy({
      worktreeScoped: false,
      requested: { filesystemScope: "unrestricted", networkAccess: "enabled", approvalPolicy: "never" },
      support: complete,
    });
    expect(result.requested).toEqual({
      filesystemScope: "unrestricted", networkAccess: "enabled", approvalPolicy: "never",
    });
  });

  it("lets an explicit sandbox policy override a stale legacy plan mode", () => {
    const result = resolveHarnessSandboxPolicy({
      permissionMode: "plan",
      worktreeScoped: true,
      requested: { filesystemScope: "unrestricted", networkAccess: "enabled", approvalPolicy: "never" },
      support: complete,
    });
    expect(result.requested).toEqual({
      filesystemScope: "unrestricted", networkAccess: "enabled", approvalPolicy: "never",
    });
  });

  it("keeps legacy plan launches read-only when no explicit policy exists", () => {
    expect(resolveHarnessSandboxPolicy({ permissionMode: "plan", worktreeScoped: true, support: complete })
      .requested.filesystemScope).toBe("read-only");
  });

  it("reports every guarantee an unsupported harness cannot enforce", () => {
    const result = resolveHarnessSandboxPolicy({
      worktreeScoped: true,
      support: { filesystem: ["read-only"], network: false, approval: false },
    });
    expect(result.effective).toEqual({
      filesystemScope: "unmanaged", networkAccess: "unmanaged", approvalPolicy: "unmanaged",
    });
    expect(result.unsupported).toEqual(["filesystem:workspace-write", "network", "approval"]);
  });
});
