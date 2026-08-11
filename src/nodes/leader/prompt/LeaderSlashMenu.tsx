import {
  Fragment,
  useId,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { Slash, CornerDownLeft, ArrowDownUp } from "lucide-react";
import { dashboardActionIcon } from "../../../dashboard-leader-actions.ts";
import type { SlashCommand } from "./slash-commands.ts";

/**
 * Split `text` around the first case-insensitive occurrence of `query` and
 * wrap the match in an emphasized span so users can see why a command matched.
 */
function highlightMatch(text: string, query: string, emphasized: boolean) {
  if (!query) return text;
  const matchIndex = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (matchIndex < 0) return text;
  const before = text.slice(0, matchIndex);
  const match = text.slice(matchIndex, matchIndex + query.length);
  const after = text.slice(matchIndex + query.length);
  return (
    <Fragment>
      {before}
      <mark
        style={{
          background: emphasized
            ? "color-mix(in srgb, var(--text-on-accent, #fff) 26%, transparent)"
            : "color-mix(in srgb, var(--accent) 26%, transparent)",
          color: "inherit",
          borderRadius: 3,
          padding: "0 1px",
        }}
      >
        {match}
      </mark>
      {after}
    </Fragment>
  );
}

export function LeaderSlashMenu({
  id,
  commands,
  selectedIndex,
  onSelect,
  onHover,
  query = "",
  anchorRef,
}: {
  id?: string;
  commands: SlashCommand[];
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
  onHover: (index: number) => void;
  query?: string;
  anchorRef?: RefObject<HTMLElement | null>;
}) {
  const [portalPosition, setPortalPosition] = useState<CSSProperties | null>(null);
  const generatedId = useId();
  const menuId = id ?? generatedId;

  useLayoutEffect(() => {
    if (!anchorRef) return;

    const updatePosition = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const bounds = anchor.getBoundingClientRect();
      const viewportPadding = 8;
      // Clear the Activity prompt's outer border as well as the input-wrap
      // edge used for horizontal sizing.
      const gap = 12;
      const availableAbove = bounds.top - gap - viewportPadding;
      const availableBelow = window.innerHeight - bounds.bottom - gap - viewportPadding;
      const placeAbove = availableAbove >= availableBelow;
      const availableHeight = Math.max(
        120,
        Math.min(340, placeAbove ? availableAbove : availableBelow),
      );
      const width = Math.max(
        0,
        Math.min(bounds.width, window.innerWidth - viewportPadding * 2),
      );
      const left = Math.min(
        Math.max(viewportPadding, bounds.left),
        Math.max(viewportPadding, window.innerWidth - viewportPadding - width),
      );

      setPortalPosition({
        position: "fixed",
        left,
        width,
        right: "auto",
        maxHeight: availableHeight,
        ...(placeAbove
          ? { top: "auto", bottom: window.innerHeight - bounds.top + gap }
          : { top: bounds.bottom + gap, bottom: "auto" }),
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchorRef]);

  return (
    <div
      id={menuId}
      role="listbox"
      aria-label="Leader context shortcuts"
      data-no-drag
      onMouseDown={(event) => event.stopPropagation()}
      style={{
        position: anchorRef ? "fixed" : "absolute",
        left: 0,
        right: 0,
        bottom: "calc(100% + 8px)",
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
        overflow: "hidden",
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-hover)",
        borderRadius: "var(--radius-panel, 10px)",
        boxShadow: "var(--shadow-lg)",
        fontFamily: "var(--font-sans)",
        ...(anchorRef && !portalPosition ? { visibility: "hidden" } : {}),
        ...(portalPosition ?? {}),
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "7px 12px",
          borderBottom: "1px solid var(--border-default)",
          background: "var(--bg-secondary)",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.07em",
            textTransform: "uppercase",
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          <Slash size={11} strokeWidth={2.5} aria-hidden="true" />
          Commands
        </span>
        <span
          style={{
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            color: "var(--text-dim)",
          }}
        >
          {commands.length} match{commands.length === 1 ? "" : "es"}
        </span>
      </div>

      <div
        style={{
          maxHeight: 240,
          minHeight: 0,
          flex: "1 1 auto",
          overflowY: "auto",
          padding: 6,
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        {commands.map((command, index) => {
          const selected = index === selectedIndex;
          const Icon = dashboardActionIcon(command.icon);
          return (
            <button
              id={`${menuId}-option-${command.id}`}
              key={command.id}
              type="button"
              role="option"
              aria-selected={selected}
              data-testid={`leader-slash-command-${command.id}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onHover(index)}
              onClick={() => onSelect(command)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                border: "none",
                borderRadius: "var(--radius-control, 6px)",
                background: selected ? "var(--accent)" : "transparent",
                color: selected
                  ? "var(--text-on-accent, #fff)"
                  : "var(--text-primary)",
                cursor: "pointer",
                textAlign: "left",
                fontFamily: "var(--font-sans)",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  width: 26,
                  height: 26,
                  borderRadius: "var(--radius-control, 6px)",
                  background: selected
                    ? "color-mix(in srgb, var(--text-on-accent, #fff) 18%, transparent)"
                    : "color-mix(in srgb, var(--accent) 14%, transparent)",
                  color: selected
                    ? "var(--text-on-accent, #fff)"
                    : "var(--accent)",
                }}
              >
                <Icon size={15} strokeWidth={2} />
              </span>
              <span
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 1,
                  minWidth: 0,
                  flex: 1,
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 650 }}>
                  {highlightMatch(command.label, query, selected)}
                </span>
                <span
                  style={{
                    maxWidth: "100%",
                    overflow: "hidden",
                    color: selected
                      ? "var(--text-on-accent, #fff)"
                      : "var(--text-muted)",
                    fontSize: 11,
                    lineHeight: 1.35,
                    opacity: selected ? 0.85 : 1,
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {command.description}
                </span>
              </span>
              {selected && (
                <kbd
                  aria-hidden="true"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 3,
                    flexShrink: 0,
                    padding: "2px 6px",
                    borderRadius: 4,
                    fontSize: 10,
                    fontFamily: "var(--font-mono)",
                    lineHeight: 1.4,
                    border:
                      "1px solid color-mix(in srgb, var(--text-on-accent, #fff) 45%, transparent)",
                    color: "var(--text-on-accent, #fff)",
                    opacity: 0.9,
                  }}
                >
                  <CornerDownLeft size={10} strokeWidth={2.5} />
                  Enter
                </kbd>
              )}
            </button>
          );
        })}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "6px 12px",
          borderTop: "1px solid var(--border-default)",
          background: "var(--bg-secondary)",
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          color: "var(--text-dim)",
        }}
      >
        <span style={FOOTER_HINT_STYLE}>
          <ArrowDownUp size={11} strokeWidth={2.5} aria-hidden="true" />
          Navigate
        </span>
        <span style={FOOTER_HINT_STYLE}>
          <CornerDownLeft size={11} strokeWidth={2.5} aria-hidden="true" />
          Select
        </span>
        <span style={{ ...FOOTER_HINT_STYLE, marginLeft: "auto" }}>
          Esc to dismiss
        </span>
      </div>
    </div>
  );
}

const FOOTER_HINT_STYLE = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
} as const;
