/**
 * Harness registry and factory.
 *
 * Maintains a mutable registry of AgentHarness instances keyed by name.
 * Harness modules register themselves on import (side-effect import pattern):
 *
 *   import "server/harness/claude/index.ts"; // registers "claude"
 *
 * Phase 0: registry wiring only. ClaudeHarness is registered in Phase 1.
 * See docs/model-agnosticism-spec.md §3.1 for the module layout.
 */

import type { AgentHarness } from "./types.ts";

const registry = new Map<string, AgentHarness>();

/**
 * Register a harness. Overwrites any existing registration with the same name.
 * Intended to be called once at startup by each harness module.
 */
export function registerHarness(harness: AgentHarness): void {
  registry.set(harness.name, harness);
}

/**
 * Retrieve a harness by name. Throws a descriptive error on unknown names so
 * misconfiguration surfaces loudly at startup rather than silently at runtime.
 */
export function getHarness(name: string): AgentHarness {
  const harness = registry.get(name);
  if (harness === undefined) {
    const known = [...registry.keys()].join(", ") || "(none registered)";
    throw new Error(
      `Unknown harness "${name}". Registered harnesses: ${known}. ` +
        `Import the harness module before calling getHarness().`,
    );
  }
  return harness;
}

/**
 * Return all registered harness names. Intended for introspection and tests.
 */
export function registeredHarnessNames(): string[] {
  return [...registry.keys()];
}
