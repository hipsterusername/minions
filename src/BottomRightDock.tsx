/**
 * BottomRightDock — single source of truth for the bottom-right cluster
 * of floating tools (Sessions, MCP, Skills, Routines).
 *
 * Replaces the previous setup where each panel managed its own
 * collapsed/expanded state and rendered its own pill. That produced
 * overlapping pills (the old Routine `⚡` circle sat on top of the MCP
 * pill at bottom:56) and let users open multiple panels at once,
 * stacking them on top of each other.
 *
 * Design contract:
 *   - Exactly one panel can be open at a time (mutex).
 *   - Pressing Escape closes the active panel.
 *   - Clicking outside the active panel closes it.
 *   - Panels render at a fixed anchor (bottom-right, above the bar);
 *     they no longer position themselves.
 *   - Live badges (counts, running indicators) flow from each panel
 *     into the bar via {@link useDockBadge}.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

// ── Types ────────────────────────────────────────────────────────────────────

export type DockPanelId = "sessions" | "mcp" | "skills";

export interface DockBadge {
  /** Numeric badge shown next to the icon. Zero or undefined hides it. */
  count?: number | undefined;
  /** Optional accent dot (e.g. "running" indicator). */
  dot?: "success" | "warning" | "danger" | undefined;
  /** Optional tail copy (e.g. "$0.42"). */
  tail?: string | undefined;
}

interface DockContextValue {
  activePanel: DockPanelId | null;
  openPanel: (id: DockPanelId) => void;
  togglePanel: (id: DockPanelId) => void;
  closePanel: () => void;
  badges: Readonly<Partial<Record<DockPanelId, DockBadge>>>;
  setBadge: (id: DockPanelId, badge: DockBadge | null) => void;
}

const DockContext = createContext<DockContextValue | null>(null);

// ── Provider ─────────────────────────────────────────────────────────────────

export function DockProvider({ children }: { children: ReactNode }) {
  const [activePanel, setActivePanel] = useState<DockPanelId | null>(null);
  const [badges, setBadges] = useState<
    Readonly<Partial<Record<DockPanelId, DockBadge>>>
  >({});

  const openPanel = useCallback((id: DockPanelId) => {
    setActivePanel(id);
  }, []);

  const togglePanel = useCallback((id: DockPanelId) => {
    setActivePanel((prev) => (prev === id ? null : id));
  }, []);

  const closePanel = useCallback(() => {
    setActivePanel(null);
  }, []);

  const setBadge = useCallback(
    (id: DockPanelId, badge: DockBadge | null) => {
      setBadges((prev) => {
        if (badge === null) {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        }
        return { ...prev, [id]: badge };
      });
    },
    [],
  );

  // Escape closes the active panel.
  useEffect(() => {
    if (activePanel == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActivePanel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activePanel]);

  const value = useMemo<DockContextValue>(
    () => ({
      activePanel,
      openPanel,
      togglePanel,
      closePanel,
      badges,
      setBadge,
    }),
    [activePanel, openPanel, togglePanel, closePanel, badges, setBadge],
  );

  return <DockContext.Provider value={value}>{children}</DockContext.Provider>;
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export function useDock(): DockContextValue {
  const ctx = useContext(DockContext);
  if (!ctx) {
    throw new Error("useDock must be used within a <DockProvider>");
  }
  return ctx;
}

/**
 * Register live badge data for one of the dock pills. Pass `null` to
 * clear. The component owning the data calls this whenever its state
 * changes; the dock bar re-renders the affected pill.
 */
export function useDockBadge(id: DockPanelId, badge: DockBadge | null): void {
  const { setBadge } = useDock();
  // Stable JSON key so we don't churn the effect on every render.
  const badgeKey = badge == null ? "null" : JSON.stringify(badge);
  useEffect(() => {
    setBadge(id, badge);
    return () => setBadge(id, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, badgeKey, setBadge]);
}

/**
 * `true` when the panel with the given id is the active panel. Panel
 * components use this instead of their own `collapsed` state.
 */
export function useDockPanelOpen(id: DockPanelId): boolean {
  return useDock().activePanel === id;
}

// ── Panel host ───────────────────────────────────────────────────────────────

/**
 * Wraps a dock panel so it's only visible when the dock has activated
 * its id. Closes on outside-click. Children render the panel body —
 * NOT the surrounding card; the host applies the consistent shell.
 */
export function DockPanel({
  id,
  width = 300,
  children,
}: {
  id: DockPanelId;
  width?: number;
  children: ReactNode;
}) {
  const { activePanel, closePanel } = useDock();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activePanel !== id) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      const root = ref.current;
      if (root && root.contains(target)) return;
      // Ignore clicks on the dock bar itself; the bar buttons handle
      // their own toggle behaviour.
      const bar = document.querySelector("[data-dock-bar]");
      if (bar && bar.contains(target)) return;
      closePanel();
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [activePanel, id, closePanel]);

  if (activePanel !== id) return null;

  return (
    <div
      ref={ref}
      data-dock-panel={id}
      style={{
        position: "absolute",
        bottom: 64,
        right: 16,
        zIndex: 100,
        width,
        maxHeight: "calc(100% - 96px)",
        background: "var(--bg-secondary)",
        border: "1px solid var(--border-default)",
        borderRadius: 10,
        boxShadow: "var(--shadow-lg)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

/**
 * Standard header for a dock panel. Title on the left, optional action
 * buttons in the middle, close button on the right.
 */
export function DockPanelHeader({
  icon,
  title,
  actions,
}: {
  icon?: ReactNode;
  title: ReactNode;
  actions?: ReactNode;
}) {
  const { closePanel } = useDock();
  return (
    <div
      style={{
        padding: "10px 12px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        borderBottom: "1px solid var(--border-default)",
        flexShrink: 0,
        gap: 8,
      }}
    >
      <span
        style={{
          fontSize: 11,
          color: "var(--text-secondary)",
          fontFamily: "var(--font-mono)",
          textTransform: "uppercase",
          letterSpacing: 1,
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          gap: 6,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {icon && <span style={{ fontSize: 14, lineHeight: 1 }}>{icon}</span>}
        {title}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
        {actions}
        <button
          type="button"
          onClick={closePanel}
          onMouseDown={(e) => e.stopPropagation()}
          aria-label="Close panel"
          title="Close (Esc)"
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-muted)",
            fontSize: 16,
            lineHeight: 1,
            cursor: "pointer",
            padding: "2px 6px",
            borderRadius: 4,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--text-primary)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--text-muted)";
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}

// ── Dock bar ─────────────────────────────────────────────────────────────────

interface DockButtonConfig {
  id: DockPanelId | "routines";
  label: string;
  icon: ReactNode;
  /** When provided, the button is action-only — it does not toggle a panel. */
  onAction?: () => void;
}

const DOT_COLOR: Record<NonNullable<DockBadge["dot"]>, string> = {
  success: "var(--status-success)",
  warning: "var(--status-creating, var(--accent))",
  danger: "var(--danger-color)",
};

function DockPill({
  config,
  active,
  badge,
  onClick,
}: {
  config: DockButtonConfig;
  active: boolean;
  badge: DockBadge | undefined;
  onClick: () => void;
}) {
  const baseColor = active ? "var(--text-primary)" : "var(--text-secondary)";

  const baseStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 10px",
    background: active ? "var(--bg-elevated)" : "transparent",
    border: active
      ? "1px solid var(--accent)"
      : "1px solid transparent",
    borderRadius: 6,
    color: baseColor,
    fontSize: 11,
    fontFamily: "var(--font-mono)",
    cursor: "pointer",
    lineHeight: 1,
    transition: "background 0.12s, border-color 0.12s, color 0.12s",
  };

  return (
    <button
      type="button"
      data-dock-pill={config.id}
      data-active={active ? "true" : "false"}
      onClick={onClick}
      onMouseDown={(e) => e.stopPropagation()}
      title={config.label}
      aria-label={config.label}
      aria-pressed={active}
      style={baseStyle}
      onMouseEnter={(e) => {
        if (active) return;
        e.currentTarget.style.background = "var(--bg-surface)";
        e.currentTarget.style.color = "var(--text-primary)";
      }}
      onMouseLeave={(e) => {
        if (active) return;
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--text-secondary)";
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 16,
          height: 16,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 14,
        }}
      >
        {config.icon}
      </span>
      <span>{config.label}</span>
      {badge?.count != null && badge.count > 0 && (
        <span
          style={{
            fontSize: 10,
            color: "var(--text-muted)",
            background: "var(--bg-primary)",
            padding: "1px 5px",
            borderRadius: 8,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {badge.count}
        </span>
      )}
      {badge?.tail && (
        <span
          style={{
            fontSize: 10,
            color: "var(--text-muted)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {badge.tail}
        </span>
      )}
      {badge?.dot && (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: DOT_COLOR[badge.dot],
            boxShadow: `0 0 6px ${DOT_COLOR[badge.dot]}`,
            display: "inline-block",
          }}
        />
      )}
    </button>
  );
}

interface DockBarProps {
  /**
   * When provided, the Routines pill is shown and clicking it invokes
   * this callback. When undefined (e.g. the `routines` feature flag is
   * off), the pill is omitted entirely.
   */
  onOpenRoutines?: (() => void) | undefined;
}

export function DockBar({ onOpenRoutines }: DockBarProps) {
  const { activePanel, togglePanel, badges } = useDock();

  const buttons: DockButtonConfig[] = useMemo(() => {
    const list: DockButtonConfig[] = [
      {
        id: "sessions",
        label: "Sessions",
        icon: <SessionsIcon />,
      },
      {
        id: "mcp",
        label: "MCP",
        icon: <McpIcon />,
      },
      {
        id: "skills",
        label: "Skills",
        icon: <SkillsIcon />,
      },
    ];
    if (onOpenRoutines) {
      list.push({
        id: "routines",
        label: "Routines",
        icon: <RoutinesIcon />,
        onAction: onOpenRoutines,
      });
    }
    return list;
  }, [onOpenRoutines]);

  return (
    <div
      data-dock-bar=""
      style={{
        position: "absolute",
        bottom: 16,
        right: 16,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: 4,
        background: "var(--bg-secondary)",
        border: "1px solid var(--border-default)",
        borderRadius: 10,
        boxShadow: "var(--shadow-md)",
      }}
    >
      {buttons.map((b, i) => (
        <span key={b.id} style={{ display: "flex", alignItems: "center" }}>
          {i > 0 && (
            <span
              aria-hidden="true"
              style={{
                width: 1,
                height: 18,
                background: "var(--border-default)",
                margin: "0 2px",
              }}
            />
          )}
          <DockPill
            config={b}
            active={b.id !== "routines" && activePanel === b.id}
            badge={b.id === "routines" ? undefined : badges[b.id]}
            onClick={() => {
              if (b.onAction) {
                b.onAction();
                return;
              }
              togglePanel(b.id as DockPanelId);
            }}
          />
        </span>
      ))}
    </div>
  );
}

// ── Icons ────────────────────────────────────────────────────────────────────
// Keep the visual language consistent: 14px stroked SVG, currentColor.

function SessionsIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="3" width="12" height="9" rx="1.5" />
      <line x1="2" y1="6" x2="14" y2="6" />
      <circle cx="4" cy="4.5" r="0.4" fill="currentColor" stroke="none" />
      <circle cx="5.5" cy="4.5" r="0.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

function McpIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="8" cy="8" r="2" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="8" y1="10" x2="8" y2="14" />
      <line x1="2" y1="8" x2="6" y2="8" />
      <line x1="10" y1="8" x2="14" y2="8" />
    </svg>
  );
}

function SkillsIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 1.5L9.6 6h4.4l-3.6 2.7L11.8 13 8 10.3 4.2 13l1.4-4.3L2 6h4.4z" />
    </svg>
  );
}

function RoutinesIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 2L4 9h3l-1 5 5-7H8z" fill="currentColor" stroke="none" />
    </svg>
  );
}
