import type { AgentHarness, HarnessSandboxResolution } from "../harness/types.ts";
import type { AgentTypeContext } from "./types.ts";

/** Advertise resolved runtime capabilities, never the pre-filter tool catalog. */
export function withLaunchCapabilities(
  context: AgentTypeContext,
  harness: AgentHarness,
  allowedTools: readonly string[],
  sandbox: HarnessSandboxResolution,
): AgentTypeContext {
  return { ...context, effectiveCapabilities: {
    allowedTools,
    nativeFilesystem: harness.capabilities.builtInFilesystem && harness.builtInTools.length === 0,
    filesystemScope: sandbox.effective.filesystemScope,
    approvalPolicy: sandbox.effective.approvalPolicy,
  } };
}
