import {
  DEFAULT_SANDBOX_POLICY,
  type SandboxPolicy,
} from "../../shared/workspace-contracts.ts";
import type { HarnessCapabilities } from "../use-socket.ts";
import { SANDBOX_ACCESS_OPTIONS, sandboxAccessValue, withSandboxAccess } from "../sandbox-access.ts";

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
          {SANDBOX_ACCESS_OPTIONS.map((option) => {
            const supported = support === undefined || support.filesystem.includes(option.filesystemScope);
            return (
              <label key={option.value} data-selected={sandboxAccessValue(value) === option.value}>
                <input
                  type="radio"
                  name="mobile-sandbox-file-access"
                  value={option.value}
                  aria-label={option.label}
                  checked={sandboxAccessValue(value) === option.value}
                  disabled={!supported}
                  onChange={() => onChange(withSandboxAccess(value, option.value))}
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
