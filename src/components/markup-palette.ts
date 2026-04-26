/**
 * Fixed colour palette for annotation markup.
 *
 * Kept small on purpose — the point is to pick *something* that stands
 * out on the underlying image, not to match a brand. Lives on its own
 * so the sidebar and any future reuse (PdfPageNode, WebPreviewNode)
 * can import without pulling in a specific UI container.
 */
export interface MarkupPaletteSwatch {
  label: string;
  color: string;
}

export const MARKUP_PALETTE: ReadonlyArray<MarkupPaletteSwatch> = [
  { label: "Accent", color: "var(--accent)" },
  { label: "Red", color: "#ef4444" },
  { label: "Amber", color: "#f59e0b" },
  { label: "Green", color: "#10b981" },
  { label: "Blue", color: "#3b82f6" },
  { label: "Violet", color: "#8b5cf6" },
];
