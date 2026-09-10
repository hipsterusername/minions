import { describe, expect, it } from "vitest";
import { resolveHarnessSandboxPolicy, sandboxPolicyForMinion } from "./sandbox-policy.ts";

const complete = {
  filesystem: ["read-only", "workspace-write", "unrestricted"] as const,
  approval: true,
};

describe("resolveHarnessSandboxPolicy", () => {
  it("retains explicit Minion access without adding it to the effective provider axes", () => {
    const requested = { filesystemScope: "unrestricted", approvalPolicy: "on-failure",
      fullHostScope: "leader-and-minions" } as const;
    expect(resolveHarnessSandboxPolicy({ requested, worktreeScoped: true, support: complete }))
      .toEqual({ requested, effective: { filesystemScope: "unrestricted", approvalPolicy: "on-failure" }, unsupported: [] });
  });
  it("defaults worktree runs to workspace-write rooted at their execution cwd", () => {
    expect(resolveHarnessSandboxPolicy({ worktreeScoped: true, support: complete }))
      .toEqual({
        requested: { filesystemScope: "workspace-write", approvalPolicy: "on-failure" },
        effective: { filesystemScope: "workspace-write", approvalPolicy: "on-failure" },
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
      requested: { filesystemScope: "unrestricted", approvalPolicy: "never" },
      support: complete,
    });
    expect(result.requested).toEqual({
      filesystemScope: "unrestricted", approvalPolicy: "never",
    });
  });

  it("lets an explicit sandbox policy override a stale legacy plan mode", () => {
    const result = resolveHarnessSandboxPolicy({
      permissionMode: "plan",
      worktreeScoped: true,
      requested: { filesystemScope: "unrestricted", approvalPolicy: "never" },
      support: complete,
    });
    expect(result.requested).toEqual({
      filesystemScope: "unrestricted", approvalPolicy: "never",
    });
  });

  it("keeps legacy plan launches read-only when no explicit policy exists", () => {
    expect(resolveHarnessSandboxPolicy({ permissionMode: "plan", worktreeScoped: true, support: complete })
      .requested.filesystemScope).toBe("read-only");
  });

  it("reports every guarantee an unsupported harness cannot enforce", () => {
    const result = resolveHarnessSandboxPolicy({
      worktreeScoped: true,
      support: { filesystem: ["read-only"], approval: false },
    });
    expect(result.effective).toEqual({
      filesystemScope: "unmanaged", approvalPolicy: "unmanaged",
    });
    expect(result.unsupported).toEqual(["filesystem:workspace-write", "approval"]);
  });
});

describe("sandboxPolicyForMinion", () => {
  const child = { filesystemScope: "read-only", approvalPolicy: "never" } as const;

  it.each([undefined, "leader-only"] as const)("keeps task restrictions for legacy/Leader-only scope %s", (fullHostScope) => {
    const parent = { filesystemScope: "unrestricted", approvalPolicy: "on-failure",
      ...(fullHostScope ? { fullHostScope } : {}) } as const;
    expect(sandboxPolicyForMinion(parent, child)).toEqual(child);
    expect(sandboxPolicyForMinion(parent, undefined)).toBeUndefined();
  });

  it("extends full host access while preserving graph approval policy", () => {
    const parent = { filesystemScope: "unrestricted", approvalPolicy: "on-failure",
      fullHostScope: "leader-and-minions" } as const;
    expect(sandboxPolicyForMinion(parent, child)).toEqual({
      ...parent, approvalPolicy: "never",
    });
    expect(sandboxPolicyForMinion(parent, undefined)).toEqual(parent);
    expect(child.filesystemScope).toBe("read-only");
  });

  it("does not extend full host access from a restricted parent", () => {
    expect(sandboxPolicyForMinion({ filesystemScope: "workspace-write", approvalPolicy: "never",
      fullHostScope: "leader-and-minions" }, child)).toEqual(child);
    expect(sandboxPolicyForMinion(undefined, child)).toEqual(child);
  });
});
