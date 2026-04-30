/**
 * Context extraction — flatten a context-providing node into a
 * {@link ContextItem} that can ride the existing prompt channel.
 *
 * Isolated from `Canvas.tsx` so the logic is unit-testable and so new node
 * types that implement `providesContext` + `extractContent` pick up
 * automatic support without touching the canvas.
 */
import type { CanvasNode, ContextItem } from "./types.ts";
import { getAttachmentExtractor, getContentExtractor } from "./node-registry.ts";

/**
 * Extract a ContextItem from a single node, or return null if the node
 * has no content to contribute.
 *
 * Preference order:
 *  1. The node type's registered `extractContent()` — any node that
 *     declares `providesContext: true` in the registry ships one and
 *     the canvas stays oblivious to per-type data shapes. ImageNode
 *     relies on this path to flatten its image + annotations into
 *     context text (Phase 3 of docs/archive/visual-context-plan.md).
 *  2. Legacy per-type branches below for the earliest node types
 *     (markdown / file-viewer / note). These will move into the
 *     registry over time.
 */
export function extractContextItem(sourceNode: CanvasNode): ContextItem | null {
  const attachmentsExtractor = getAttachmentExtractor(sourceNode.type);
  const attachments = attachmentsExtractor?.(sourceNode.data) ?? null;
  const withAttachments = <T extends ContextItem>(item: T): T =>
    attachments && attachments.length > 0 ? { ...item, attachments } : item;

  const extractor = getContentExtractor(sourceNode.type);
  if (extractor) {
    const content = extractor(sourceNode.data);
    // A node with no text but at least one attachment (e.g. an image
    // node whose user never added an annotation) still has something
    // worth sending — promote a placeholder label so the item survives
    // the filter below.
    const hasText = !!content && !!content.trim();
    if (!hasText && (!attachments || attachments.length === 0)) return null;
    const d = sourceNode.data as
      | { filename?: string; title?: string; filePath?: string }
      | undefined;
    const label = d?.filename || d?.title || d?.filePath || sourceNode.type;
    return withAttachments({
      nodeId: sourceNode.id,
      nodeType: sourceNode.type,
      label,
      content: hasText ? (content as string) : "",
    });
  }

  let content = "";
  let label = "";

  if (sourceNode.type === "markdown") {
    const mdData = sourceNode.data as { title: string; content: string; viewMode: string };
    content = mdData.content;
    label = mdData.title || "Markdown";
  } else if (sourceNode.type === "file-viewer") {
    const fvData = sourceNode.data as { filePath: string; loadedContent?: string };
    content = fvData.loadedContent ?? "";
    label = fvData.filePath || "File";
  } else if (sourceNode.type === "note") {
    const noteData = sourceNode.data as { text: string; color: string };
    content = noteData.text;
    label = "Note";
  }

  if (!content.trim()) return null;
  return withAttachments({ nodeId: sourceNode.id, nodeType: sourceNode.type, label, content });
}
