/**
 * DashboardSurface — presentational render-DSL dashboard.
 *
 * Extracted from the retired `RenderNode` so the same live dashboard can be
 * embedded directly inside the Leader node (split-pane / tabbed body) instead
 * of living in a separate auto-spawned canvas node.
 *
 * This component is purely presentational: it receives `renderState` (and an
 * optional wire `payloadError`) as props and owns only local UI state
 * (context selection, copy feedback, section expand/collapse). Wiring the
 * `render_update` subscription and persisting `renderState` is the host's
 * responsibility (see `LeaderNode`).
 */

import { useCallback, useMemo, useState } from "react";
import type { RenderState } from "../../../shared/render-dsl.ts";
import {
  flattenRenderStateToText,
  formatRenderComponentToText,
} from "../../render-flatten.ts";
import { copyText as copyToClipboard } from "../../components/CopyButton.tsx";
import { browserLogger } from "../../logging.ts";
import {
  CLS,
  DashboardSelectionButton,
  DashboardSelectionGroup,
  RenderComponentView,
  SelectableDashboardComponent,
  gridColumnFor,
  hasSectionComponent,
} from "../RenderNode.tsx";

const log = browserLogger.child("dashboard-surface");

export interface DashboardSurfaceProps {
  /** The dashboard state to render (layout + components). */
  renderState: RenderState;
  /** Wire-validation error for the most recent render_update, if any. */
  payloadError?: string | null | undefined;
  /** Fired when a `form` component is submitted. */
  onSubmitForm?: ((componentId: string, answers: Record<string, unknown>) => void) | undefined;
  /** Add the selected/flattened dashboard text to the canvas as a content node. */
  onAddContentNode?: ((text: string) => void) | undefined;
  /** Hide the surface header (host provides its own chrome, e.g. a tab bar). */
  hideHeader?: boolean | undefined;
}

/**
 * Renders the dashboard header + scrollable component grid. Fills its parent
 * (width/height 100%); the host supplies the outer frame/border.
 */
export function DashboardSurface({
  renderState,
  payloadError = null,
  onSubmitForm,
  onAddContentNode,
  hideHeader = false,
}: DashboardSurfaceProps) {
  const { layout, components } = renderState;
  const columns = layout.columns ?? 2;
  const gap = layout.gap ?? 12;
  const hasContent = components.length > 0;

  const [contextSelectionActive, setContextSelectionActive] = useState(false);
  const [selectedComponentIds, setSelectedComponentIds] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [sectionExpansionState, setSectionExpansionState] = useState<boolean | undefined>(undefined);

  const hasSections = useMemo(() => hasSectionComponent(components), [components]);
  const selectedIdSet = useMemo(() => new Set(selectedComponentIds), [selectedComponentIds]);
  const selectedText = useMemo(
    () =>
      components
        .filter((component) => selectedIdSet.has(component.id))
        .map(formatRenderComponentToText)
        .join("\n\n"),
    [components, selectedIdSet],
  );
  const fullDashboardText = useMemo(
    () => flattenRenderStateToText(renderState),
    [renderState],
  );

  const toggleSelectedComponent = useCallback((componentId: string) => {
    setContextSelectionActive(true);
    setSelectedComponentIds((current) =>
      current.includes(componentId)
        ? current.filter((id) => id !== componentId)
        : [...current, componentId],
    );
  }, []);
  const copyTextValue = useCallback((text: string) => {
    void copyToClipboard(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch((err: unknown) => {
        log.warn("copy_failed", { error: err });
      });
  }, []);
  const exitContextSelection = useCallback(() => {
    setContextSelectionActive(false);
    setSelectedComponentIds([]);
    setCopied(false);
  }, []);

  return (
    <div
      className="dashboard-surface"
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {!hideHeader && (
        <div
          style={{
            padding: "8px 14px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderBottom: "1px solid var(--border-default)",
            flexShrink: 0,
            background: "var(--bg-secondary)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <img
              src="/icons/dashboard.svg"
              alt="Dashboard"
              width={18}
              height={18}
              style={{ display: "block", flexShrink: 0 }}
            />
            <span style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--text-primary)",
              letterSpacing: "-0.01em",
            }}>
              {layout.title || "Dashboard"}
            </span>
          </div>
          {hasContent && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              {hasSections && (
                <button
                  type="button"
                  onClick={() => setSectionExpansionState((open) => open === true ? false : true)}
                  aria-label={
                    sectionExpansionState === true
                      ? "Collapse all dashboard sections"
                      : "Expand all dashboard sections"
                  }
                  style={{
                    padding: "4px 8px",
                    borderRadius: 5,
                    border: "1px solid var(--border-default)",
                    background: "var(--bg-surface)",
                    color: "var(--text-secondary)",
                    cursor: "pointer",
                    fontSize: 10,
                    fontFamily: "var(--font-mono)",
                    lineHeight: 1.2,
                  }}
                >
                  {sectionExpansionState === true ? "Collapse all" : "Expand all"}
                </button>
              )}
              <span style={{
                fontSize: 9,
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                opacity: 0.7,
              }}>
                {components.length} component{components.length !== 1 ? "s" : ""}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Content area — scroll-capture zone so wheel/trackpad scroll over the
          dashboard scrolls its content instead of zooming/panning the canvas. */}
      <div
        className={hasContent ? CLS.scrollArea : undefined}
        data-scroll-capture
        style={{
          flex: 1,
          overflow: "auto",
          padding: hasContent ? gap : 0,
          overscrollBehavior: "contain",
        }}
      >
        {payloadError !== null && (
          <div
            role="alert"
            style={{
              margin: gap,
              padding: "8px 12px",
              background: "var(--error-bg, #fef2f2)",
              border: "1px solid var(--status-error, #dc2626)",
              borderRadius: 6,
              fontSize: 11,
              color: "var(--status-error, #dc2626)",
              fontFamily: "var(--font-mono, monospace)",
              wordBreak: "break-all",
            }}
          >
            {payloadError}
          </div>
        )}
        {!hasContent ? (
          <div style={{
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            gap: 10,
            color: "var(--text-muted)",
            padding: 24,
          }}>
            <div style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: "var(--bg-secondary)",
              border: "1px solid var(--border-default)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: 0.5,
            }}>
              <img
                src="/icons/dashboard.svg"
                alt="Dashboard"
                width={28}
                height={28}
                style={{ display: "block" }}
              />
            </div>
            <div style={{ fontSize: 12, textAlign: "center", lineHeight: 1.6 }}>
              Waiting for dashboard data...
              <br />
              <span style={{ fontSize: 10, opacity: 0.6 }}>
                The Leader agent will populate this panel
              </span>
            </div>
          </div>
        ) : (
          <>
            {contextSelectionActive && (
              <div
                data-testid="render-context-selection-toolbar"
                style={{
                  position: "sticky",
                  top: 0,
                  zIndex: 20,
                  display: "flex",
                  justifyContent: "flex-end",
                  marginBottom: gap,
                  pointerEvents: "none",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    padding: 2,
                    borderRadius: 5,
                    background: "var(--bg-primary)",
                    border: "1px solid var(--border-default)",
                    boxShadow: "var(--shadow-sm)",
                    pointerEvents: "auto",
                  }}
                >
                  <span
                    aria-live="polite"
                    style={{
                      padding: "0 5px",
                      color: "var(--text-muted)",
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {selectedComponentIds.length} component
                    {selectedComponentIds.length === 1 ? "" : "s"}
                  </span>
                  {copied && (
                    <span
                      role="status"
                      data-testid="render-context-copied"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 3,
                        padding: "0 5px",
                        color: "var(--status-success)",
                        fontFamily: "var(--font-mono)",
                        fontSize: 10,
                        whiteSpace: "nowrap",
                      }}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2.5}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      Copied
                    </span>
                  )}
                  <DashboardSelectionGroup label="Selection controls">
                    <DashboardSelectionButton
                      icon="select-all"
                      label="Select all dashboard components"
                      onClick={() => setSelectedComponentIds(components.map((component) => component.id))}
                      disabled={components.length === 0}
                    />
                    <DashboardSelectionButton
                      icon="clear"
                      label="Clear selected dashboard components"
                      onClick={() => setSelectedComponentIds([])}
                      disabled={selectedComponentIds.length === 0}
                    />
                  </DashboardSelectionGroup>
                  <DashboardSelectionGroup label="Copy and create actions">
                    <DashboardSelectionButton
                      icon="copy"
                      label="Copy selected dashboard context"
                      onClick={() => copyTextValue(selectedText)}
                      disabled={selectedText.length === 0}
                      tone="primary"
                    />
                    <DashboardSelectionButton
                      icon="node"
                      label="Add selected dashboard context as node"
                      onClick={() => onAddContentNode?.(selectedText)}
                      disabled={!onAddContentNode || selectedText.length === 0}
                      tone="primary"
                    />
                    <DashboardSelectionButton
                      icon="copy-full"
                      label="Copy full dashboard context"
                      onClick={() => copyTextValue(fullDashboardText)}
                      disabled={fullDashboardText.length === 0}
                      tone="primary"
                    />
                  </DashboardSelectionGroup>
                  <DashboardSelectionGroup label="Selection mode">
                    <DashboardSelectionButton
                      icon="exit"
                      label="Exit dashboard context selection"
                      onClick={exitContextSelection}
                    />
                  </DashboardSelectionGroup>
                </div>
              </div>
            )}
            <div
              className="rd-grid-container"
              style={{
                containerType: "inline-size",
                ["--rd-max-cols" as string]: String(columns),
                ["--rd-gap" as string]: `${gap}px`,
              }}
            >
              <div
                className="rd-grid"
                style={{
                  display: "grid",
                  gridTemplateColumns: `repeat(var(--rd-cols, ${columns}), minmax(0, 1fr))`,
                  gap,
                  alignContent: "start",
                  alignItems: "start",
                  gridAutoRows: "min-content",
                  gridAutoFlow: "dense",
                }}
              >
                {components.map((c) => {
                  const col = gridColumnFor(c, columns);
                  return (
                    <div key={c.id} style={{ gridColumn: col, minWidth: 0 }}>
                      <SelectableDashboardComponent
                        componentId={c.id}
                        selectionActive={contextSelectionActive}
                        selected={selectedIdSet.has(c.id)}
                        onToggle={toggleSelectedComponent}
                      >
                        <RenderComponentView
                          component={c}
                          context={{
                            onSubmitForm,
                            sectionExpansionState,
                          }}
                        />
                      </SelectableDashboardComponent>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
