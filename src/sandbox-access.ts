import type { FilesystemScope, SandboxPolicy } from "../shared/workspace-contracts.ts";

export const SANDBOX_ACCESS_OPTIONS = [
  { value: "read-only", filesystemScope: "read-only", label: "Read only",
    description: "Inspect workspace files without editing them." },
  { value: "workspace-write", filesystemScope: "workspace-write", label: "Workspace write",
    description: "Read and edit files in authorized project roots." },
  { value: "unrestricted", filesystemScope: "unrestricted", label: "Full Host - Leader Only",
    description: "Remove the process sandbox for the Leader. Minions keep their task sandbox." },
  { value: "unrestricted-with-minions", filesystemScope: "unrestricted", label: "Full Host - Leader + Minions",
    description: "Remove the process sandbox for the Leader and its Minions." },
] as const satisfies ReadonlyArray<{
  value: string; filesystemScope: FilesystemScope; label: string; description: string;
}>;

export function sandboxAccessValue(policy: SandboxPolicy): string {
  return policy.filesystemScope === "unrestricted" && policy.fullHostScope === "leader-and-minions"
    ? "unrestricted-with-minions" : policy.filesystemScope;
}

export function withSandboxAccess(policy: SandboxPolicy, access: string): SandboxPolicy {
  const option = SANDBOX_ACCESS_OPTIONS.find((candidate) => candidate.value === access);
  if (!option) return policy;
  const { fullHostScope: _scope, ...axes } = policy;
  return {
    ...axes,
    filesystemScope: option.filesystemScope,
    ...(option.filesystemScope === "unrestricted" ? {
      fullHostScope: access === "unrestricted-with-minions" ? "leader-and-minions" : "leader-only",
    } as const : {}),
  };
}
