import type { SandboxPolicy, SandboxResolution } from "../../../shared/workspace-contracts.ts";

export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = {
  filesystemScope: "workspace-write",
  approvalPolicy: "on-failure",
  networkAccess: "disabled",
};

export function SandboxPolicyControls({ policy, effective, disabled = false, onChange }: {
  policy?: SandboxPolicy | undefined;
  effective?: SandboxResolution | null | undefined;
  disabled?: boolean;
  onChange: (policy: SandboxPolicy) => void;
}) {
  const value = policy ?? DEFAULT_SANDBOX_POLICY;
  const update = (patch: Partial<SandboxPolicy>) => onChange({ ...value, ...patch });
  const actual = effective?.effective;
  return (
    <fieldset className="leader-sandbox-policy" disabled={disabled}>
      <legend>Execution sandbox</legend>
      <label>
        <span>Files</span>
        <select aria-label="Sandbox file access" value={value.filesystemScope}
          onChange={(event) => update({ filesystemScope: event.target.value as SandboxPolicy["filesystemScope"] })}>
          <option value="read-only">Read only</option>
          <option value="workspace-write">Workspace write</option>
          <option value="unrestricted">Full host access</option>
        </select>
      </label>
      <label>
        <span>Approval</span>
        <select aria-label="Sandbox approval policy" value={value.approvalPolicy}
          onChange={(event) => update({ approvalPolicy: event.target.value as SandboxPolicy["approvalPolicy"] })}>
          <option value="always">Always ask</option>
          <option value="on-request">On request</option>
          <option value="on-failure">On failure</option>
          <option value="never">Never ask</option>
        </select>
      </label>
      <label>
        <span>Network</span>
        <select aria-label="Sandbox network access" value={value.networkAccess}
          onChange={(event) => update({ networkAccess: event.target.value as SandboxPolicy["networkAccess"] })}>
          <option value="disabled">Disabled</option>
          <option value="enabled">Enabled</option>
        </select>
      </label>
      <small>
        Git change mode controls where edits land; this policy controls what the agent process can access.
      </small>
      {actual ? (
        <output className="leader-sandbox-effective">
          Effective: {actual.filesystemScope} · {actual.approvalPolicy} · network {actual.networkAccess}
          {effective.unsupported.length > 0 ? ` · unmanaged: ${effective.unsupported.join(", ")}` : ""}
        </output>
      ) : null}
    </fieldset>
  );
}
