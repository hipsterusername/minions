/** Find existing destinations by default; switch explicitly to create a node. */
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
import "./command-palette.css";

export type PaletteItem =
  | { kind: "node"; type: string; label: string }
  | { kind: "preset"; id: string; label: string; description?: string };

interface CommandPaletteProps {
  items: PaletteItem[];
  nodes: CanvasNode[];
  zoneNames?: ReadonlyMap<string, string>;
  nodeContext?: Record<string, string>;
  onCreate: (item: PaletteItem, value: string) => void;
  onJump: (nodeId: string) => void;
  onClose: () => void;
}

const PALETTE_INPUT_MAX_HEIGHT = 160;
const PALETTE_MAX_NODE_RESULTS = 8;

/** Compact label for the node type selector ("New Leader" → "Leader"). */
function toggleLabel(item: PaletteItem): string {
  return item.label.replace(/^New\s+/i, "");
}

/**
 * Order create targets so the selector defaults to Leader, then Markdown, then
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
  zoneNames,
  nodeContext = {},
  onCreate,
  onJump,
  onClose,
}: CommandPaletteProps) {
  const [mode, setMode] = useState<"find" | "create">("find");
  const [query, setQuery] = useState("");
  // -1 is the creation action; >= 0 selects a navigation result.
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Selected node type or preset for explicit creation.
  const [createIndex, setCreateIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const trimmed = query.trim();

  const createItems = useMemo(() => orderCreateItems(items), [items]);
  const createTarget = createItems[createIndex] ?? createItems[0];

  const results = useMemo<NodeSearchEntry[]>(() => {
    if (mode === "create") return [];
    return searchNodes(nodes, trimmed).slice(0, PALETTE_MAX_NODE_RESULTS);
  }, [nodes, trimmed, mode]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);

  // Find never falls through to creation, including when there are no results.
  useEffect(() => {
    setSelectedIndex(mode === "find" ? 0 : -1);
  }, [query, mode]);

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
      ?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex]);

  const activateSelection = () => {
    if (selectedIndex >= 0) {
      const entry = results[selectedIndex];
      if (entry) onJump(entry.nodeId);
      return;
    }
    if (mode === "create" && createTarget) onCreate(createTarget, trimmed);
  };

  const targetLabel = createTarget ? toggleLabel(createTarget) : "node";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1100,
        background: "rgba(0, 0, 0, 0.28)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: 96,
      }}
      onMouseDown={onClose}
    >
      <div
        ref={dialogRef}
        className="canvas-command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); onClose(); }
          if (event.key !== "Tab" || event.defaultPrevented) return;
          const elements = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea, select, [tabindex="0"]') ?? [])];
          const first = elements[0];
          const last = elements.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}
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
        <div style={{ display: "flex", gap: 8, padding: "10px 12px", alignItems: "center" }}>
          {(["find", "create"] as const).map(value => <button key={value} type="button" aria-pressed={mode === value}
            onClick={() => { setMode(value); inputRef.current?.focus(); }}
            style={{ padding: "7px 12px", borderRadius: 6, border: "1px solid var(--border-default)", background: mode === value ? "var(--accent)" : "transparent", color: mode === value ? "var(--text-on-accent)" : "var(--text-secondary)", cursor: "pointer", font: "inherit", fontSize: 13 }}>
            {value === "find" ? "Find on canvas" : "Create node"}
          </button>)}
          <button type="button" onClick={onClose} aria-label="Close command palette" style={{ marginLeft: "auto", minWidth: 32, minHeight: 32, background: "transparent", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 20 }}>×</button>
        </div>
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
            aria-label={mode === "find" ? "Find on canvas" : "New node content"}
            aria-describedby="canvas-palette-help"
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
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
                  // Return to navigation results after a live result update.
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
                  // Keep Find on the first destination; never select creation.
                  e.preventDefault();
                  setSelectedIndex(mode === "find" ? 0 : -1);
                }
                // selectedIndex === -1: let the caret move within the text.
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                activateSelection();
              }
            }}
            placeholder={mode === "find" ? "Search by name or content…" : "Describe your new node…"}
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
          {mode === "create" && createTarget && <select aria-label="Node type" value={createIndex}
            onChange={event => setCreateIndex(Number(event.target.value))}
            style={{ alignSelf: "center", maxWidth: "40%", padding: "8px", borderRadius: 6, border: "1px solid var(--border-default)", background: "var(--bg-elevated)", color: "var(--text-primary)", font: "inherit", fontSize: 13 }}>
            {createItems.map((item, index) => <option key={item.kind === "node" ? item.type : item.id} value={index}>{toggleLabel(item)}</option>)}
          </select>}
        </div>
        {mode === "create" && createTarget && <button type="button" className="canvas-command-palette__create"
          onClick={() => onCreate(createTarget, trimmed)}>Create {targetLabel}</button>}
        <span className="canvas-command-palette__sr" role="status">{mode === "find" && results[selectedIndex] ? `${selectedIndex + 1} of ${results.length}: ${results[selectedIndex]?.title}` : ""}</span>
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
                aria-current={active ? "true" : undefined}
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
                  {`${zoneNames?.has(entry.nodeId) ? `Open in ${zoneNames.get(entry.nodeId)}` : `Jump to ${entry.typeLabel}`}${nodeContext[entry.nodeId] ? ` · ${nodeContext[entry.nodeId]}` : ""}${entry.snippet ? ` · ${entry.snippet}` : ""}`}
                </span>
              </button>
            );
          })}
          {mode === "find" && trimmed.length > 0 && results.length === 0 && (
            <div
              style={{ padding: 12, fontSize: 12, color: "var(--text-muted)" }}
            >
              No matching nodes. Try another name or phrase.
            </div>
          )}
          {(
            <div
              style={{ padding: 12, fontSize: 12, color: "var(--text-muted)" }}
            >
              <span id="canvas-palette-help">{mode === "find" ? (nodes.length === 0 ? "No nodes on this canvas yet. Choose Create node to get started." : "↑ ↓ choose a destination · Enter opens it · Esc closes") : `Enter creates a ${targetLabel} · Shift+Enter adds a line`}</span>
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
