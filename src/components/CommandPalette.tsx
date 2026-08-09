/**
 * CommandPalette — the Ctrl+K overlay.
 *
 * Two concerns share one text field:
 *  1. Create — a type toggle sits to the right of the input (default "Leader").
 *     Tab cycles it (→ Markdown → …other creatable types/presets). Enter with
 *     the toggle selected creates that node, seeded with the typed text (see
 *     applyPromptSeed / createNode).
 *  2. Search — typing filters existing canvas nodes into the list below.
 *     ArrowDown steps from the create toggle into those results; Enter on a
 *     result jumps to that node.
 *
 * The input auto-grows to a max height then scrolls; matching logic lives in
 * ../node-search.ts.
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { CanvasNode } from "../types.ts";
import { searchNodes, type NodeSearchEntry } from "../node-search.ts";

export type PaletteItem =
  | { kind: "node"; type: string; label: string }
  | { kind: "preset"; id: string; label: string; description?: string };

interface CommandPaletteProps {
  items: PaletteItem[];
  nodes: CanvasNode[];
  onCreate: (item: PaletteItem, value: string) => void;
  onJump: (nodeId: string) => void;
  onClose: () => void;
}

const PALETTE_INPUT_MAX_HEIGHT = 160;
const PALETTE_MAX_NODE_RESULTS = 8;

/** Compact label for the create toggle ("New Leader" → "Leader"). */
function toggleLabel(item: PaletteItem): string {
  return item.label.replace(/^New\s+/i, "");
}

/**
 * Order create targets so the toggle defaults to Leader, then Markdown, then
 * everything else in its original order (Array.sort is stable).
 */
function orderCreateItems(items: PaletteItem[]): PaletteItem[] {
  const rank = (item: PaletteItem): number => {
    if (item.kind === "node" && item.type === "leader") return 0;
    if (item.kind === "node" && item.type === "markdown") return 1;
    return 2;
  };
  return [...items].sort((a, b) => rank(a) - rank(b));
}

export function CommandPalette({
  items,
  nodes,
  onCreate,
  onJump,
  onClose,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  // -1 selects the create toggle (the default); >= 0 selects a search result.
  const [selectedIndex, setSelectedIndex] = useState(-1);
  // Which create target the toggle points at.
  const [createIndex, setCreateIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const trimmed = query.trim();

  const createItems = useMemo(() => orderCreateItems(items), [items]);
  const createTarget = createItems[createIndex] ?? createItems[0];

  const results = useMemo<NodeSearchEntry[]>(() => {
    if (!trimmed) return [];
    return searchNodes(nodes, trimmed).slice(0, PALETTE_MAX_NODE_RESULTS);
  }, [nodes, trimmed]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Any edit drops the highlight back to the create toggle.
  useEffect(() => {
    setSelectedIndex(-1);
  }, [query]);

  // Auto-grow the input up to a max height, then switch on internal scroll so
  // long prompts stay readable instead of scrolling off the top of the bar.
  useLayoutEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, PALETTE_INPUT_MAX_HEIGHT)}px`;
    ta.style.overflowY =
      ta.scrollHeight > PALETTE_INPUT_MAX_HEIGHT ? "auto" : "hidden";
  }, [query]);

  // Keep the highlighted result in view during keyboard navigation.
  useEffect(() => {
    if (selectedIndex < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row="${selectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const cycleCreateTarget = () => {
    if (createItems.length === 0) return;
    setCreateIndex((idx) => (idx + 1) % createItems.length);
    setSelectedIndex(-1);
  };

  const activateSelection = () => {
    if (selectedIndex >= 0) {
      const entry = results[selectedIndex];
      if (entry) onJump(entry.nodeId);
      return;
    }
    if (createTarget) onCreate(createTarget, trimmed);
  };

  const toggleSelected = selectedIndex < 0;
  const nextTarget = createItems[(createIndex + 1) % Math.max(createItems.length, 1)];
  const targetLabel = createTarget ? toggleLabel(createTarget) : "node";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 700,
        background: "rgba(0, 0, 0, 0.28)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: 96,
      }}
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: "min(640px, calc(100vw - 32px))",
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-hover)",
          borderRadius: 8,
          boxShadow: "var(--shadow-lg)",
          overflow: "hidden",
          fontFamily: "var(--font-sans)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "stretch",
            background: "var(--bg-secondary)",
            gap: 8,
            padding: "8px 10px 8px 0",
          }}
        >
          <textarea
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
                return;
              }
              if (e.key === "Tab") {
                // Tab switches what will be created (Leader → Markdown → …).
                e.preventDefault();
                cycleCreateTarget();
                return;
              }
              if (e.key === "ArrowDown") {
                const ta = e.currentTarget;
                const caretAtEnd =
                  ta.selectionStart === ta.value.length &&
                  ta.selectionEnd === ta.value.length;
                if (selectedIndex >= 0) {
                  e.preventDefault();
                  setSelectedIndex((idx) =>
                    Math.min(results.length - 1, idx + 1),
                  );
                } else if (caretAtEnd && results.length > 0) {
                  // Step from the create toggle down into search results.
                  e.preventDefault();
                  setSelectedIndex(0);
                }
                return;
              }
              if (e.key === "ArrowUp") {
                if (selectedIndex > 0) {
                  e.preventDefault();
                  setSelectedIndex((idx) => idx - 1);
                } else if (selectedIndex === 0) {
                  // Return to the create toggle from the first result.
                  e.preventDefault();
                  setSelectedIndex(-1);
                }
                // selectedIndex === -1: let the caret move within the text.
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                activateSelection();
              }
            }}
            placeholder="Search nodes, or type to create…"
            rows={1}
            style={{
              flex: 1,
              resize: "none",
              border: "none",
              outline: "none",
              background: "transparent",
              color: "var(--text-primary)",
              padding: "8px 0 8px 18px",
              fontSize: 15,
              lineHeight: "22px",
              minHeight: 38,
              fontFamily: "var(--font-sans)",
            }}
          />
          {createTarget && (
            <button
              type="button"
              aria-label={`Create ${toggleLabel(createTarget)} — press Tab to switch type`}
              aria-pressed={toggleSelected}
              title={
                nextTarget && nextTarget !== createTarget
                  ? `Tab → ${toggleLabel(nextTarget)}`
                  : "Create type"
              }
              onMouseDown={(e) => e.preventDefault()} // keep focus in the input
              onClick={() => {
                setSelectedIndex(-1);
                cycleCreateTarget();
              }}
              style={{
                alignSelf: "center",
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 10px",
                borderRadius: 6,
                border: `1px solid ${toggleSelected ? "var(--accent)" : "var(--border-hover)"}`,
                background: toggleSelected ? "var(--accent)" : "var(--bg-elevated)",
                color: toggleSelected
                  ? "var(--text-on-accent)"
                  : "var(--text-primary)",
                cursor: "pointer",
                fontFamily: "var(--font-sans)",
                fontSize: 13,
                fontWeight: 650,
                whiteSpace: "nowrap",
              }}
            >
              <span>{toggleLabel(createTarget)}</span>
              <kbd
                aria-hidden="true"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 2,
                  padding: "1px 5px",
                  borderRadius: 4,
                  fontSize: 10,
                  fontFamily: "var(--font-mono)",
                  lineHeight: 1.4,
                  border: `1px solid ${toggleSelected ? "var(--text-on-accent)" : "var(--border-hover)"}`,
                  color: "inherit",
                  opacity: 0.8,
                }}
              >
                ⇥ Tab
              </kbd>
            </button>
          )}
        </div>
        <div
          ref={listRef}
          style={{ padding: 6, maxHeight: 320, overflowY: "auto" }}
        >
          {results.length > 0 && (
            <div style={GROUP_LABEL_STYLE}>Jump to node</div>
          )}
          {results.map((entry, index) => {
            const active = index === selectedIndex;
            return (
              <button
                key={`jump:${entry.nodeId}`}
                type="button"
                data-row={index}
                aria-selected={active}
                onClick={() => onJump(entry.nodeId)}
                onMouseEnter={() => setSelectedIndex(index)}
                style={{
                  width: "100%",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 2,
                  padding: "9px 12px",
                  border: "none",
                  borderLeft: `3px solid ${active ? "var(--accent)" : "transparent"}`,
                  borderRadius: 6,
                  background: active ? "var(--accent)" : "transparent",
                  color: active ? "var(--text-on-accent)" : "var(--text-primary)",
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: "var(--font-sans)",
                }}
              >
                <span style={ROW_PRIMARY_STYLE}>{entry.title}</span>
                <span
                  style={{
                    ...ROW_SECONDARY_STYLE,
                    color: active
                      ? "var(--text-on-accent)"
                      : "var(--text-muted)",
                    opacity: active ? 0.85 : 1,
                  }}
                >
                  {`Jump to ${entry.typeLabel}${entry.snippet ? ` · ${entry.snippet}` : ""}`}
                </span>
              </button>
            );
          })}
          {trimmed.length > 0 && results.length === 0 && (
            <div
              style={{ padding: 12, fontSize: 12, color: "var(--text-muted)" }}
            >
              No matching nodes — Enter creates a {targetLabel}.
            </div>
          )}
          {trimmed.length === 0 && (
            <div
              style={{ padding: 12, fontSize: 12, color: "var(--text-muted)" }}
            >
              Type to search nodes · Enter creates a {targetLabel} · Tab
              switches type
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const GROUP_LABEL_STYLE: CSSProperties = {
  padding: "6px 12px 2px",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontFamily: "var(--font-mono)",
};

const ROW_PRIMARY_STYLE: CSSProperties = {
  fontSize: 13,
  fontWeight: 650,
  maxWidth: "100%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const ROW_SECONDARY_STYLE: CSSProperties = {
  fontSize: 11,
  fontFamily: "var(--font-mono)",
  maxWidth: "100%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
