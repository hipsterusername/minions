/**
 * Utilities for delta-based connected-context injection in LeaderNode.
 *
 * Extracted from `src/nodes/LeaderNode.tsx` so that LeaderNode (which is
 * over-budget in tests/architecture/file-size.test.ts) does not grow when
 * the context-dedup feature is added.
 *
 * IMPORTANT: The exact wrapper text produced by `buildContextBlock` is
 * matched by a regex inside `server/session-host-config.ts` `deriveTaskName`.
 * Do NOT change it without also updating that regex.
 */

import type { ContextItem } from "./types.ts";

// ── Types ─────────────────────────────────────────────────────────────────

export type CanvasContextSignature = string | null;

export interface CanvasContextSnapshotSendArgs {
  socketSend?: ((data: unknown) => void) | undefined;
  sessionKey: string | null | undefined;
  items: ContextItem[];
  previousSignature: CanvasContextSignature;
}

// ── Hashing ───────────────────────────────────────────────────────────────

/**
 * djb2-variant string hash (stable, fast, good distribution for short strings).
 * Returns an unsigned 32-bit integer.
 */
export function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h;
}

// ── Block builder ─────────────────────────────────────────────────────────

/**
 * Build a `<connected-context>` XML block from a list of context items.
 *
 * Returns `null` when `items` is empty (callers can skip injecting the block).
 *
 * The wrapper text `<connected-context>\n The following context has been
 * provided...` is referenced by `deriveTaskName` in
 * `server/session-host-config.ts` and MUST be preserved verbatim.
 */
export function buildContextBlock(items: ContextItem[]): string | null {
  if (items.length === 0) return null;

  const attachments = items.flatMap((item) => item.attachments ?? []);
  const contextBlock = items
    .map((item) => {
      const isDefault = item.label.toLowerCase() === item.nodeType.toLowerCase();
      const openTag = isDefault
        ? `<context-group>`
        : `<context-group title="${item.label}">`;
      return `${openTag}\n${item.content}\n</context-group>`;
    })
    .join("\n");

  const attachmentHint =
    attachments.length > 0
      ? `\n\nThe user has also attached ${attachments.length} image${
          attachments.length === 1 ? "" : "s"
        } — see the image block${attachments.length === 1 ? "" : "s"} in this turn.`
      : "";

  return `<connected-context>\nThe following context has been provided by the user via connected canvas nodes:\n\n${contextBlock}${attachmentHint}\n</connected-context>`;
}

// ── Hash helpers ──────────────────────────────────────────────────────────

/**
 * Compute a stable content hash for a single ContextItem. Shared with the
 * delivery ledger in `src/context-delivery.ts` and the edge-staleness check
 * in `src/context-staleness.ts` — all three must agree on what "changed"
 * means.
 */
export function itemContentHash(item: ContextItem): number {
  return hashString(`${item.label}\0${item.nodeType}\0${item.content}`);
}

function itemSnapshotHash(item: ContextItem): number {
  const attachments = item.attachments ?? [];
  return hashString(
    [
      item.nodeId,
      item.label,
      item.nodeType,
      item.content,
      ...attachments.map(
        (attachment) =>
          `${attachment.kind}\0${attachment.filename ?? ""}\0${attachment.mediaType}\0${attachment.data.length}`,
      ),
    ].join("\0"),
  );
}

export function canvasContextSignature(
  items: ContextItem[],
): CanvasContextSignature {
  if (items.length === 0) return null;
  return items
    .map((item) => `${item.nodeId}:${itemSnapshotHash(item)}`)
    .join("|");
}

export function sendCanvasContextSnapshotIfChanged({
  socketSend,
  sessionKey,
  items,
  previousSignature,
}: CanvasContextSnapshotSendArgs): CanvasContextSignature {
  const nextSignature = canvasContextSignature(items);
  if (!socketSend || !sessionKey || nextSignature === previousSignature) {
    return previousSignature;
  }
  // `blocks` is client-side delivery metadata (duplicate of `content`);
  // strip it so the server snapshot payload isn't doubled.
  const wireItems = items.map(({ blocks: _blocks, ...rest }) => rest);
  socketSend({ type: "canvas_context", sessionKey, items: wireItems });
  return nextSignature;
}
