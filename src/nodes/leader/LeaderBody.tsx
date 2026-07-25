/**
 * LeaderBody — responsive conversation + workspace layout for the Leader node.
 *
 * Progressive disclosure:
 *   - No dashboard data yet  → render chat only (looks exactly like before the
 *     embedded dashboard existed).
 *   - Has data + node is wide → split-pane: conversation left, workspace
 *     right, with Dashboard and Minions grouped as peer tabs when both exist.
 *   - Has data + node is narrow → one tab row for Conversation, Dashboard,
 *     and Minions, defaulting to Conversation (chat-forward).
 *
 * This keeps the dashboard embedded in the leader card, replacing the retired
 * standalone `render` node.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { RenderState } from "../../../shared/render-dsl.ts";
import { DashboardSurface } from "../render/DashboardSurface.tsx";
import { PaneDivider } from "./fullscreen/PaneDivider.tsx";

/** Below this content width, the split collapses to a tab toggle. */
export const LEADER_BODY_SPLIT_MIN_WIDTH = 640;
/** Default chat-pane fraction of the split (chat-forward → chat gets more). */
export const LEADER_BODY_DEFAULT_SPLIT = 0.56;
const MIN_CHAT_FRACTION = 0.3;
const MAX_CHAT_FRACTION = 0.78;

function clampChatFraction(v: number): number {
  if (!Number.isFinite(v)) return LEADER_BODY_DEFAULT_SPLIT;
  return Math.min(MAX_CHAT_FRACTION, Math.max(MIN_CHAT_FRACTION, v));
}

export interface LeaderBodyProps {
  /** The chat column: messages feed + config footer + prompt bar. */
  chat: ReactNode;
  renderState: RenderState;
  payloadError?: string | null | undefined;
  onSubmitForm?: ((componentId: string, answers: Record<string, unknown>) => void) | undefined;
  onAddContentNode?: ((text: string) => void) | undefined;
  /** Persisted tab selection when narrow. Chat-forward when unset. */
  activeBodyView?: "chat" | "dashboard" | "minions" | undefined;
  onActiveBodyViewChange?: ((view: "chat" | "dashboard" | "minions") => void) | undefined;
  /** Persisted chat-pane fraction of the split. */
  splitRatio?: number | undefined;
  onSplitRatioChange?: ((ratio: number) => void) | undefined;
  /**
   * Content pinned to the top of the dashboard pane (e.g. the task plan), so it
   * only occupies the dashboard half rather than spanning the full node width.
   */
  dashboardHeader?: ReactNode;
  /**
   * Whether {@link dashboardHeader} currently has content. When true, the
   * dashboard side is revealed even before any render components arrive so the
   * plan has somewhere to live.
   */
  dashboardHeaderActive?: boolean | undefined;
  /** Consolidated minion browser rendered in the same workspace as Dashboard. */
  minions?: ReactNode;
  minionsActive?: boolean | undefined;
  minionCount?: number | undefined;
}

export function LeaderBody({
  chat,
  renderState,
  payloadError,
  onSubmitForm,
  onAddContentNode,
  activeBodyView,
  onActiveBodyViewChange,
  splitRatio,
  onSplitRatioChange,
  dashboardHeader,
  dashboardHeaderActive,
  minions,
  minionsActive,
  minionCount,
}: LeaderBodyProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number>(0);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // Seed from the current layout width first, then let the observer take
    // over — so the observed value always wins over the initial read.
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const hasRenderContent = renderState.components.length > 0;
  // The dashboard side is shown when there are render components OR a task plan
  // to host — so the plan lives on the dashboard half, never full width.
  const showDashboard = hasRenderContent || !!dashboardHeaderActive;
  const showMinions = !!minionsActive && minions != null;
  const showWorkspace = showDashboard || showMinions;
  const chatFraction = clampChatFraction(splitRatio ?? LEADER_BODY_DEFAULT_SPLIT);
  const isWide = width >= LEADER_BODY_SPLIT_MIN_WIDTH;
  const requestedView = activeBodyView ?? "chat";
  const workspaceView: "dashboard" | "minions" =
    requestedView === "minions" && showMinions
      ? "minions"
      : showDashboard
        ? "dashboard"
        : "minions";
  const view: "chat" | "dashboard" | "minions" =
    requestedView === "chat"
      ? "chat"
      : requestedView === "minions" && showMinions
        ? "minions"
        : requestedView === "dashboard" && showDashboard
          ? "dashboard"
          : showDashboard
            ? "dashboard"
            : showMinions
              ? "minions"
              : "chat";

  const handleDividerResize = useCallback(
    (deltaX: number) => {
      if (!onSplitRatioChange || width <= 0) return;
      const next = clampChatFraction(chatFraction + deltaX / width);
      onSplitRatioChange(next);
    },
    [onSplitRatioChange, width, chatFraction],
  );

  const dashboard = useMemo(
    () => (
      <div style={fillColumn}>
        {dashboardHeader != null && (
          <div style={{ flexShrink: 0 }}>{dashboardHeader}</div>
        )}
        {hasRenderContent && (
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <DashboardSurface
              renderState={renderState}
              payloadError={payloadError}
              onSubmitForm={onSubmitForm}
              onAddContentNode={onAddContentNode}
            />
          </div>
        )}
      </div>
    ),
    [dashboardHeader, hasRenderContent, renderState, payloadError, onSubmitForm, onAddContentNode],
  );

  const workspace = (
    <div style={fillColumn}>
      {showDashboard && showMinions && (
        <WorkspaceTabs
          active={workspaceView}
          minionCount={minionCount ?? 0}
          onChange={(next) => onActiveBodyViewChange?.(next)}
        />
      )}
      <div style={{ ...fillColumn, display: workspaceView === "dashboard" ? "flex" : "none" }}>
        {dashboard}
      </div>
      {workspaceView === "minions" && <div style={fillColumn}>{minions}</div>}
    </div>
  );

  // Progressive disclosure: nothing to show on the dashboard side → chat only
  // (unchanged look).
  if (!showWorkspace) {
    return (
      <div ref={rootRef} style={fillColumn}>
        {chat}
      </div>
    );
  }

  // Wide → split-pane (conversation left, workspace right).
  if (isWide) {
    return (
      <div ref={rootRef} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "row" }}>
        <div style={{ flex: `0 0 ${(chatFraction * 100).toFixed(3)}%`, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {chat}
        </div>
        <PaneDivider
          side="left"
          onResize={handleDividerResize}
          onReset={() => onSplitRatioChange?.(LEADER_BODY_DEFAULT_SPLIT)}
          ariaLabel="Resize conversation and workspace panes"
        />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", borderLeft: "1px solid var(--border-default)" }}>
          {workspace}
        </div>
      </div>
    );
  }

  // Narrow → one tab row for all available surfaces, chat-forward default.
  return (
    <div ref={rootRef} style={fillColumn}>
      <div
        role="tablist"
        aria-label="Leader body view"
        style={{
          display: "flex",
          flexShrink: 0,
          gap: 2,
          padding: "4px 6px",
          borderBottom: "1px solid var(--border-default)",
          background: "var(--bg-secondary)",
        }}
      >
        <BodyTab label="Conversation" active={view === "chat"} onClick={() => onActiveBodyViewChange?.("chat")} />
        {showDashboard && <BodyTab label="Dashboard" active={view === "dashboard"} onClick={() => onActiveBodyViewChange?.("dashboard")} />}
        {showMinions && <BodyTab label={`Minions${(minionCount ?? 0) > 0 ? ` (${minionCount})` : ""}`} active={view === "minions"} onClick={() => onActiveBodyViewChange?.("minions")} />}
      </div>
      {/* Keep chat mounted (hidden) so scroll/stream state survives tab switches. */}
      <div style={{ ...fillColumn, display: view === "chat" ? "flex" : "none" }}>{chat}</div>
      {view === "dashboard" && <div style={fillColumn}>{dashboard}</div>}
      {view === "minions" && <div style={fillColumn}>{minions}</div>}
    </div>
  );
}

function WorkspaceTabs({
  active,
  minionCount,
  onChange,
}: {
  active: "dashboard" | "minions";
  minionCount: number;
  onChange: (view: "dashboard" | "minions") => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Leader workspace"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 18,
        minHeight: 36,
        padding: "0 14px",
        borderBottom: "1px solid var(--border-default)",
        background: "var(--bg-secondary)",
        flexShrink: 0,
      }}
    >
      <WorkspaceTab label="Dashboard" active={active === "dashboard"} onClick={() => onChange("dashboard")} />
      <WorkspaceTab label={`Minions · ${minionCount}`} active={active === "minions"} onClick={() => onChange("minions")} />
    </div>
  );
}

function WorkspaceTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        alignSelf: "stretch",
        padding: "0 1px",
        border: "none",
        borderBottom: `2px solid ${active ? "var(--accent)" : "transparent"}`,
        background: "transparent",
        color: active ? "var(--text-primary)" : "var(--text-muted)",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: active ? 650 : 500,
      }}
    >
      {label}
    </button>
  );
}

const fillColumn = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
} as const;

function BodyTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        flex: 1,
        padding: "5px 8px",
        borderRadius: 5,
        border: "1px solid",
        borderColor: active ? "color-mix(in srgb, var(--accent) 40%, var(--border-default))" : "transparent",
        background: active ? "color-mix(in srgb, var(--accent) 12%, var(--bg-surface))" : "transparent",
        color: active ? "var(--accent)" : "var(--text-secondary)",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: active ? 600 : 500,
        letterSpacing: "-0.01em",
      }}
    >
      {label}
    </button>
  );
}
