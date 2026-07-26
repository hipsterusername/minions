/**
 * Feature-flag registry surfaced through debug mode.
 *
 * Why this exists: we sometimes want to disable a still-evolving feature
 * for everyone by default while keeping the code paths in the tree, so
 * a developer toggling **debug mode** (Ctrl+Shift+D) can flip it back
 * on locally without redeploying. {@link debug.ts} owns the
 * "I am instrumenting the UI" bit; this module owns the "which features
 * are turned on" bits.
 *
 * Design choices (mirroring {@link debug.ts}):
 *   - **localStorage-backed** so toggles survive reloads.
 *   - **Single JSON blob** under one key — adding a flag does not migrate
 *     storage.
 *   - **Pub/sub** so React components subscribe via `useSyncExternalStore`
 *     and don't poll.
 *   - **Definitions live in code**, not localStorage. The persisted blob
 *     only carries overrides; an unknown id is ignored on read so a
 *     stale browser doesn't break the app after a flag is removed.
 */

const STORAGE_KEY = "minions:feature-flags";

/**
 * Static description of a flag. The `id` is the persisted key and the
 * stable identifier used by callers; everything else is for the debug
 * panel UI.
 */
export interface FeatureFlagDefinition {
  /** Stable string id; also the localStorage subkey. */
  id: string;
  /** Short label shown in the debug toggle list. */
  label: string;
  /** One-line explanation shown beneath the label in the debug panel. */
  description: string;
  /** Default value when the user has not explicitly toggled the flag. */
  defaultValue: boolean;
}

/**
 * Stable id for the MCP-servers feature flag. Exported so gating call
 * sites and tests reference one constant instead of a loose string.
 */
export const FLAG_MCP_SERVERS = "mcp-servers";

/**
 * Stable id for the experimental Dialectic node feature flag. Gates the
 * Dialectic node's visibility in the create palette/context menu.
 */
export const FLAG_DIALECTIC = "dialectic";

/**
 * Registry of every flag the app knows about.
 *
 * Keep this short. A flag is a temporary tool — when a feature is either
 * fully shipped or fully removed, delete the entry rather than letting
 * the registry rot. (Per project convention: replace, don't deprecate.)
 */
export const FEATURE_FLAGS: ReadonlyArray<FeatureFlagDefinition> = [
  {
    id: FLAG_MCP_SERVERS,
    label: "MCP servers",
    description:
      "Project-owned MCP server management (the MCP dock panel). Still evolving — off by default.",
    defaultValue: false,
  },
  {
    id: FLAG_DIALECTIC,
    label: "Dialectic node",
    description:
      "Experimental dual-planner node: two agents debate a plan in a structured, cache-optimized back-and-forth. Off by default.",
    defaultValue: false,
  },
];

/** Map view of {@link FEATURE_FLAGS} for O(1) lookup by id. */
const DEFINITIONS_BY_ID: ReadonlyMap<string, FeatureFlagDefinition> = new Map(
  FEATURE_FLAGS.map((d) => [d.id, d]),
);

// ── Storage ────────────────────────────────────────────────────────────────

/** Read the persisted overrides. Always returns a fresh object. */
function readOverrides(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeOverrides(overrides: Record<string, boolean>): void {
  if (typeof window === "undefined") return;
  try {
    if (Object.keys(overrides).length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    }
  } catch {
    /* localStorage unavailable — keep going so listeners still fire. */
  }
}

// ── Public read/write ──────────────────────────────────────────────────────

/**
 * Read the current value of a flag. Unknown ids return `false` so a
 * misspelled call site fails closed rather than crashing the app.
 */
export function getFeatureFlag(id: string): boolean {
  const def = DEFINITIONS_BY_ID.get(id);
  if (!def) return false;
  const overrides = readOverrides();
  return Object.hasOwn(overrides, id) ? overrides[id]! : def.defaultValue;
}

/**
 * Snapshot of every flag's current value, including defaults for flags
 * the user has never toggled. Returned object is frozen so consumers
 * can't accidentally mutate the registry.
 */
export function getAllFeatureFlags(): Readonly<Record<string, boolean>> {
  const overrides = readOverrides();
  const out: Record<string, boolean> = {};
  for (const def of FEATURE_FLAGS) {
    out[def.id] = Object.hasOwn(overrides, def.id)
      ? overrides[def.id]!
      : def.defaultValue;
  }
  return Object.freeze(out);
}

/**
 * Write a flag's value and notify subscribers. Setting the value back to
 * its default removes the override so the persisted blob stays small.
 */
export function setFeatureFlag(id: string, value: boolean): void {
  const def = DEFINITIONS_BY_ID.get(id);
  if (!def) return;
  const overrides = readOverrides();
  if (value === def.defaultValue) {
    if (!Object.hasOwn(overrides, id)) return;
    delete overrides[id];
  } else {
    if (overrides[id] === value) return;
    overrides[id] = value;
  }
  writeOverrides(overrides);
  notify();
}

/** Reset every flag to its default. Used by tests and the debug panel. */
export function resetFeatureFlags(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  notify();
}

// ── Pub/sub ────────────────────────────────────────────────────────────────

const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* listener errors must not break siblings */
    }
  });
}

/** Subscribe to any flag change. Returns an unsubscribe fn. */
export function subscribeFeatureFlags(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * `useSyncExternalStore` adapter for a single flag. The returned object
 * has stable function identities so React hook deps stay quiet.
 */
export function featureFlagStore(id: string): {
  subscribe: (fn: () => void) => () => void;
  getSnapshot: () => boolean;
} {
  return {
    subscribe(fn: () => void): () => void {
      return subscribeFeatureFlags(fn);
    },
    getSnapshot(): boolean {
      return getFeatureFlag(id);
    },
  };
}
