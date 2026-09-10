import {
  DEFAULT_SANDBOX_POLICY,
  type SandboxPolicy,
  type SandboxResolution,
} from "../../../shared/workspace-contracts.ts";
import type { HarnessCapabilities } from "../../use-socket.ts";
import { SANDBOX_ACCESS_OPTIONS, sandboxAccessValue, withSandboxAccess } from "../../sandbox-access.ts";

export { DEFAULT_SANDBOX_POLICY };

const SANDBOX_HELP = {
  filesystem: "Sets the agent process's file boundary. Read only prevents edits, Workspace write limits edits to authorized project roots, and Full Host removes that boundary for the Leader only or for the Leader and its Minions.",
  approval: "Controls when guarded actions can ask to run outside the current sandbox. Always ask is strictest; Never ask rejects escalation instead of prompting.",
} as const;

function SandboxHelp({ axis, description }: { axis: string; description: string }) {
  return (
    <span
      className="leader-sandbox-help"
      role="img"
      tabIndex={0}
      aria-label={`About sandbox ${axis}`}
      title={description}
    >
      ?
    </span>
  );
}

export function SandboxPolicyControls({ policy, effective, support, disabled = false, onChange }: {
  policy?: SandboxPolicy | undefined;
  effective?: SandboxResolution | null | undefined;
  /** undefined while inventory loads; null means the harness does not enforce any axis. */
  support?: HarnessCapabilities["sandboxEnforcement"] | null | undefined;
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
        <span className="leader-sandbox-label">
          Files
          <SandboxHelp axis="file access" description={SANDBOX_HELP.filesystem} />
        </span>
        {support === undefined || (support !== null && support.filesystem.length > 0) ? (
          <select aria-label="Sandbox file access" value={sandboxAccessValue(value)}
            onChange={(event) => onChange(withSandboxAccess(value, event.target.value))}>
            {SANDBOX_ACCESS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}
                disabled={support !== undefined && (support === null || !support.filesystem.includes(option.filesystemScope))}>
                {option.label}
              </option>
            ))}
          </select>
        ) : <output aria-label="Sandbox file access">Unmanaged by harness</output>}
      </label>
      <label>
        <span className="leader-sandbox-label">
          Approval
          <SandboxHelp axis="approval policy" description={SANDBOX_HELP.approval} />
        </span>
        {support === undefined || (support !== null && support.approval) ? (
          <select aria-label="Sandbox approval policy" value={value.approvalPolicy}
            onChange={(event) => update({ approvalPolicy: event.target.value as SandboxPolicy["approvalPolicy"] })}>
            <option value="always">Always ask</option>
            <option value="on-request">On request</option>
            <option value="on-failure">On failure</option>
            <option value="never">Never ask</option>
          </select>
        ) : <output aria-label="Sandbox approval policy">Unmanaged by harness</output>}
      </label>
      <small>
        Git change mode controls where edits land; this policy controls what the agent process can access.
      </small>
      {actual ? (
        <output className="leader-sandbox-effective">
          Effective: {actual.filesystemScope} · {actual.approvalPolicy}
          {effective.unsupported.length > 0 ? ` · unmanaged: ${effective.unsupported.join(", ")}` : ""}
        </output>
      ) : null}
    </fieldset>
  );
}
