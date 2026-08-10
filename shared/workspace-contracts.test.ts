import { describe, expect, it } from "vitest";
import {
  approvalPolicySchema,
  filesystemScopeSchema,
  sandboxPolicySchema,
  sandboxResolutionSchema,
  workspaceIdSchema,
  workspaceRefSchema,
} from "./workspace-contracts.ts";

const WORKSPACE_ID = "8dcf241e-52b8-4d50-a2f3-9b12fdab7a1c";

describe("workspace identity contracts", () => {
  it("accepts an opaque UUID without a path", () => {
    expect(workspaceIdSchema.parse(WORKSPACE_ID)).toBe(WORKSPACE_ID);
    expect(workspaceRefSchema.parse({ workspaceId: WORKSPACE_ID })).toEqual({
      workspaceId: WORKSPACE_ID,
    });
  });

  it("represents unsupported harness guarantees without claiming enforcement", () => {
    expect(sandboxResolutionSchema.parse({
      requested: {
        filesystemScope: "workspace-write",
        approvalPolicy: "on-request",
      },
      effective: {
        filesystemScope: "unmanaged",
        approvalPolicy: "unmanaged",
      },
      unsupported: ["filesystem:workspace-write", "approval"],
    }).unsupported).toHaveLength(2);
  });

  it.each([
    "/mnt/projects/example",
    "C:\\projects\\example",
    "project-name",
    "",
  ])("rejects path-derived or non-opaque identity %j", (value) => {
    expect(workspaceIdSchema.safeParse(value).success).toBe(false);
  });

  it("does not permit paths in a workspace reference", () => {
    expect(workspaceRefSchema.safeParse({
      workspaceId: WORKSPACE_ID,
      path: "/projects/example",
    }).success).toBe(false);
  });
});

describe("sandbox policy contracts", () => {
  it("represents filesystem and approval posture independently", () => {
    expect(sandboxPolicySchema.parse({
      filesystemScope: "workspace-write",
      approvalPolicy: "on-request",
    })).toEqual({
      filesystemScope: "workspace-write",
      approvalPolicy: "on-request",
    });
  });

  it("requires both policy axes", () => {
    expect(sandboxPolicySchema.safeParse({
      filesystemScope: "read-only",
    }).success).toBe(false);
  });

  it("rejects invalid enum values", () => {
    expect(filesystemScopeSchema.safeParse("repository-write").success).toBe(false);
    expect(approvalPolicySchema.safeParse("sometimes").success).toBe(false);
    expect(sandboxPolicySchema.safeParse({
      filesystemScope: "workspace-write",
      approvalPolicy: "sometimes",
    }).success).toBe(false);
  });

  it("normalizes the removed network axis from persisted policies", () => {
    expect(sandboxPolicySchema.parse({
      filesystemScope: "workspace-write",
      approvalPolicy: "on-request",
      networkAccess: "disabled",
    })).toEqual({
      filesystemScope: "workspace-write",
      approvalPolicy: "on-request",
    });
    expect(sandboxResolutionSchema.parse({
      requested: {
        filesystemScope: "workspace-write",
        approvalPolicy: "on-request",
        networkAccess: "disabled",
      },
      effective: {
        filesystemScope: "workspace-write",
        approvalPolicy: "on-request",
        networkAccess: "disabled",
      },
      unsupported: ["network"],
    }).unsupported).toEqual([]);
  });

  it("rejects provider-specific extension fields", () => {
    expect(sandboxPolicySchema.safeParse({
      filesystemScope: "unrestricted",
      approvalPolicy: "never",
      providerMode: "custom",
    }).success).toBe(false);
  });
});
