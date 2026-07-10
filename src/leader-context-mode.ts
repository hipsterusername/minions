import type { CanvasNode, ContextItem } from "./types.ts";
import type { DisplayMessage } from "./sdk-messages.ts";
import {
  buildLeaderTranscriptBlocks,
  TRANSCRIPT_BLOCK_SEPARATOR,
} from "./nodes/leader/transcript-builder.ts";

export type ContextEdgeMode = "dashboard" | "lean" | "full";

export const DEFAULT_CONTEXT_MODE: ContextEdgeMode = "dashboard";

/**
 * The output-context options shown by the leader dashboard output-port drop
 * menu, in display order. Each `type` round-trips through
 * {@link resolveContextMode} back to its {@link ContextEdgeMode}, and is the
 * mode stamped onto the context edge created for the new downstream leader.
 */
export const CONTEXT_MODE_MENU_OPTIONS: ReadonlyArray<{
  label: string;
  type: ContextEdgeMode;
}> = [
  { label: "Dashboard", type: "dashboard" },
  { label: "Lean", type: "lean" },
  { label: "Full", type: "full" },
];

/** Normalize a possibly-undefined edge mode to a concrete mode. */
export function resolveContextMode(mode: string | undefined): ContextEdgeMode {
  return mode === "lean" || mode === "full" ? mode : DEFAULT_CONTEXT_MODE;
}

/**
 * Merge the upstream-leader framing preamble (if any) ahead of a leader's
 * existing system-prompt prefix. Returns the base prefix unchanged when no
 * lean/full context is incoming.
 */
export function mergeContextPreamble(
  modes: ContextEdgeMode[],
  basePrefix?: string | null,
): string | null | undefined {
  const preamble = buildLeaderContextPreamble(modes);
  if (!preamble) return basePrefix;
  return basePrefix && basePrefix.trim()
    ? `${preamble}\n\n${basePrefix}`
    : preamble;
}

/**
 * Build a ContextItem from an upstream **leader** node for the "lean"/"full"
 * modes by flattening its session transcript. Returns null when the mode is
 * "dashboard" (caller should fall back to the node's default extractor) or
 * when the leader has no forwardable messages yet.
 */
export function resolveLeaderContextItem(
  sourceNode: CanvasNode,
  mode: ContextEdgeMode,
): ContextItem | null {
  if (mode !== "lean" && mode !== "full") return null;
  const data = sourceNode.data as
    | { messages?: DisplayMessage[]; taskName?: string | null }
    | undefined;
  const messages = data?.messages ?? [];
  const blocks = buildLeaderTranscriptBlocks(messages, mode);
  const content = blocks.join(TRANSCRIPT_BLOCK_SEPARATOR);
  if (!content.trim()) return null;
  const label =
    data?.taskName && data.taskName.trim() ? data.taskName : "Leader Session";
  return {
    nodeId: sourceNode.id,
    nodeType: sourceNode.type,
    label,
    content,
    // Append-only block list: lets follow-up turns deliver only the suffix of
    // new transcript blocks instead of re-sending the whole transcript.
    blocks,
  };
}

export function buildLeaderContextPreamble(modes: ContextEdgeMode[]): string | null {
  if (modes.includes("full")) {
    return "One or more connected upstream Leader sessions have provided a transcript of their conversation in the connected-context block. It includes user inputs, the assistant's internal thinking and reasoning, and the assistant's responses; tool calls are excluded. Use it to continue that work with full continuity.";
  }

  if (modes.includes("lean")) {
    return "One or more connected upstream Leader sessions have provided a transcript of their conversation in the connected-context block. It includes user inputs and assistant responses only; internal thinking and tool calls are omitted. Use it for continuity.";
  }

  return null;
}
