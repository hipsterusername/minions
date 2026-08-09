import type { NormalizedEvent } from "../shared/normalized-event.ts";
import type { Bus } from "./bus.ts";
import { serverLogger } from "./logging.ts";

const log = serverLogger.child("mutation-observability");

export interface MutationDescriptor {
  operation: "write" | "delete" | "rename" | "shell";
  paths: string[];
  opaque: boolean;
}

export type MutationCoverage = "extracted" | "opaque" | "non_mutating" | "unknown";

export interface MutationToolObservation {
  harness: string;
  toolName: string;
  coverage: MutationCoverage;
  potentiallyMutating: boolean;
  descriptor: MutationDescriptor | null;
}

const CLAUDE_NON_MUTATING = new Set([
  "Read", "Glob", "Grep", "Agent", "WebFetch", "WebSearch",
]);
const MUTATION_NAME_HINT =
  /(?:^|[_-])(write|edit|patch|delete|remove|rename|move|create|update|apply)(?:$|[_-])/i;
const COORDINATION_TOOLS = new Set(["open_change_intent", "close_change_intent"]);

function recordInput(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function extractedPath(input: unknown, ...keys: string[]): string[] {
  const record = recordInput(input);
  if (!record) return [];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return [value.trim()];
  }
  return [];
}

function extractedPaths(input: unknown, ...keys: string[]): string[] {
  const record = recordInput(input); if (!record) return [];
  return [...new Set(keys.flatMap((key) => {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return [value.trim()];
    if (Array.isArray(value)) return value.filter((item): item is string =>
      typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
    return [];
  }))];
}

function patchPaths(input: unknown): string[] {
  const record = recordInput(input);
  const patch = record && ["patch", "input", "diff"].map((key) => record[key])
    .find((value): value is string => typeof value === "string");
  if (!patch) return [];
  return [...new Set([...patch.matchAll(/^\*\*\* (?:Add|Update|Delete|Move to) File: (.+)$/gm)]
    .map((match) => match[1]!.trim()))];
}

function mutation(
  harness: string,
  toolName: string,
  operation: MutationDescriptor["operation"],
  paths: string[],
  forceOpaque = false,
): MutationToolObservation {
  const opaque = forceOpaque || paths.length === 0;
  return {
    harness,
    toolName,
    coverage: opaque ? "opaque" : "extracted",
    potentiallyMutating: true,
    descriptor: { operation, paths: [...new Set(paths)], opaque },
  };
}

/**
 * Describe one normalized tool call without coordinating or delaying it.
 * Adapter-specific knowledge intentionally lives here rather than in generic
 * tool-name parsing, so `extracted` means the input shape is understood.
 */
export function observeMutationToolCall(
  harness: string,
  event: Extract<NormalizedEvent, { kind: "tool_call" }>,
): MutationToolObservation {
  const leafName = event.name.split("__").at(-1) ?? event.name;
  if (COORDINATION_TOOLS.has(leafName)) return { harness, toolName: event.name,
    coverage: "non_mutating", potentiallyMutating: false, descriptor: null };
  if (harness === "claude") {
    if (["Write", "Edit", "NotebookEdit"].includes(event.name)) {
      return mutation(harness, event.name, "write", extractedPaths(event.input,
        "file_path", "path", "notebook_path"));
    }
    if (event.name === "Bash") return mutation(harness, event.name, "shell", [], true);
    if (CLAUDE_NON_MUTATING.has(event.name)) {
      return {
        harness,
        toolName: event.name,
        coverage: "non_mutating",
        potentiallyMutating: false,
        descriptor: null,
      };
    }
  }

  const lowerName = event.name.toLowerCase();
  if (lowerName.includes("rename") || lowerName.includes("move")) {
    return mutation(harness, event.name, "rename", extractedPaths(event.input,
      "from", "to", "source", "destination", "old_path", "new_path", "from_path", "to_path"));
  }
  if (lowerName.includes("delete") || lowerName.includes("remove")) {
    return mutation(harness, event.name, "delete", extractedPaths(event.input,
      "file_path", "path", "paths", "target_path"));
  }
  if (lowerName.includes("patch") || lowerName.includes("apply")) {
    return mutation(harness, event.name, "write", [...extractedPaths(event.input,
      "file_path", "path", "paths"), ...patchPaths(event.input)]);
  }
  if (MUTATION_NAME_HINT.test(event.name)) {
    return mutation(harness, event.name, "write", extractedPaths(event.input,
      "file_path", "path", "paths", "target_path"));
  }

  if (harness === "codex") {
    if (event.name === "codex_command") return mutation(harness, event.name, "shell", [], true);
    // The SDK exposes changed paths only on the later result, so the
    // pre-execution normalized call is necessarily opaque today.
    if (event.name === "codex_file_change") return mutation(harness, event.name, "write", [], true);
  }

  return {
    harness,
    toolName: event.name,
    coverage: "unknown",
    potentiallyMutating: MUTATION_NAME_HINT.test(event.name),
    descriptor: null,
  };
}

export function describeMutationToolCall(
  harness: string, callId: string, name: string, input: unknown,
): MutationToolObservation {
  return observeMutationToolCall(harness, { kind: "tool_call", id: callId, name, input });
}

/** Emit additive, observe-only coverage telemetry at the normalized boundary. */
export function emitMutationToolObservation(args: {
  bus: Bus;
  sessionKey: string;
  /** Immutable per-run identity. Defaults to sessionKey for legacy callers. */
  runKey?: string;
  /** Durable work identity. Null when the session has not been backfilled yet. */
  workItemId?: string | null;
  harness: string;
  event: Extract<NormalizedEvent, { kind: "tool_call" }>;
  timestamp: number;
}): MutationToolObservation {
  const observation = observeMutationToolCall(args.harness, args.event);
  const runKey = args.runKey ?? args.sessionKey;
  const workItemId = args.workItemId ?? null;
  const payload = {
    type: "mutation_tool_observed",
    sessionKey: args.sessionKey,
    runKey,
    workItemId,
    callId: args.event.id,
    observeOnly: true,
    ...observation,
    timestamp: args.timestamp,
  };
  // Known reads/searches already appear as sdk_events. Duplicating each one
  // onto the WebSocket adds noise without improving mutation awareness; their
  // structured debug record below still provides adapter coverage telemetry.
  if (observation.coverage !== "non_mutating") {
    args.bus.emitToSession(args.sessionKey, payload);
  }

  const fields = {
    sessionKey: args.sessionKey,
    runKey,
    workItemId,
    callId: args.event.id,
    ...observation,
  };
  if (observation.coverage === "unknown" && observation.potentiallyMutating) {
    log.warn("unknown_mutation_tool_observed", fields);
  } else if (observation.potentiallyMutating) {
    log.info("mutation_tool_observed", fields);
  } else {
    log.debug("mutation_tool_coverage_observed", fields);
  }
  return observation;
}
