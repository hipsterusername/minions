/**
 * Harness inventory shared on the client.
 *
 * Mirrors the payload shape the server emits in response to the
 * `list_harnesses` WS command. The data is pulled from each registered
 * `AgentHarness.staticInfo()` plus its declared `capabilities` and
 * `builtInTools` — see server/commands/list-harnesses.ts.
 * It drives the harness picker and model dropdown in `SessionToolbar`.
 */

import type { HarnessCapabilities } from "./use-socket.ts";

/** Static metadata for a single registered harness. */
export interface HarnessInfo {
  name: string;
  capabilities: HarnessCapabilities;
  builtInTools: string[];
  models: ReadonlyArray<{ id: string; label: string }>;
  commands: ReadonlyArray<{ name: string; description: string }>;
  agents: ReadonlyArray<{ id: string; description: string }>;
  account: { provider: string } & Record<string, unknown>;
}

/**
 * Look up a registered harness by name. Returns `undefined` when the
 * inventory hasn't loaded yet or the harness is no longer registered —
 * callers must fall back to safe defaults rather than throwing.
 */
export function findHarness(
  harnesses: ReadonlyArray<HarnessInfo>,
  name: string | null | undefined,
): HarnessInfo | undefined {
  if (!name) return undefined;
  return harnesses.find((h) => h.name === name);
}

/**
 * Default harness name when neither the session nor the user has picked
 * one. Matches the server-side default in `SessionHost`.
 */
export const DEFAULT_HARNESS_NAME = "claude";
