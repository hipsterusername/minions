import {
  DEFAULT_SANDBOX_POLICY,
  type FilesystemScope,
  type SandboxPolicy,
} from "../../shared/workspace-contracts.ts";
import type { HarnessCapabilities } from "../use-socket.ts";

const ACCESS_OPTIONS: ReadonlyArray<{
  value: FilesystemScope;
  label: string;
  description: string;
}> = [
  {
    value: "read-only",
    label: "Read only",
    description: "Inspect workspace files without editing them.",
  },
  {
    value: "workspace-write",
    label: "Workspace write",
    description: "Read and edit files in authorized project roots.",
  },
  {
    value: "unrestricted",
    label: "Full host access",
    description: "Remove the filesystem boundary for this run.",
  },
];

interface MobileSandboxAccessControlProps {
  policy?: SandboxPolicy | undefined;
  /** undefined while inventory loads; null means the harness does not enforce filesystem scope. */
  support?: HarnessCapabilities["sandboxEnforcement"] | null | undefined;
  onChange: (policy: SandboxPolicy) => void;
}

export function MobileSandboxAccessControl({
  policy,
  support,
  onChange,
}: MobileSandboxAccessControlProps) {
  const value = policy ?? DEFAULT_SANDBOX_POLICY;
  const filesystemManaged = support === undefined || (support !== null && support.filesystem.length > 0);
  const selectedScopeSupported = support === undefined
    || (support !== null && support.filesystem.includes(value.filesystemScope));

  return (
    <fieldset className="mob-sandbox-access">
      <legend>File access</legend>
      {filesystemManaged ? (
        <div className="mob-sandbox-access-options">
          {ACCESS_OPTIONS.map((option) => {
            const supported = support === undefined || support.filesystem.includes(option.value);
            return (
              <label key={option.value} data-selected={value.filesystemScope === option.value}>
                <input
                  type="radio"
                  name="mobile-sandbox-file-access"
                  value={option.value}
                  aria-label={option.label}
                  checked={value.filesystemScope === option.value}
                  disabled={!supported}
                  onChange={() => onChange({ ...value, filesystemScope: option.value })}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
              </label>
            );
          })}
        </div>
      ) : (
        <p className="mob-sandbox-unmanaged">Unmanaged by the selected harness</p>
      )}
      {filesystemManaged && !selectedScopeSupported ? (
        <p className="mob-sandbox-unmanaged">
          The selected harness does not enforce this file-access scope.
        </p>
      ) : null}
      <p className="mob-control-help">
        This controls the agent process boundary. Worktree isolation only controls where edits land.
      </p>
    </fieldset>
  );
}
