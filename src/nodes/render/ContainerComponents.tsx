/**
 * Container renderers for the render DSL — `SectionRenderer` (collapsible
 * group) and `TabsRenderer` (tabbed panel).
 *
 * Both accept a `renderChild` callback so `RenderNode.tsx` can pass in the
 * existing `<RenderComponentView component={child} />` as the child dispatcher,
 * keeping the dispatch logic in one place.
 *
 * Card styling mirrors the existing primitives in `RenderNode.tsx` so containers
 * feel native to the dashboard. CSS variables (`--bg-secondary`, `--border-default`,
 * `--accent`, …) come from the shared theme.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import type { ReactElement, KeyboardEvent } from "react";
import type { SectionComponent, TabsComponent, TabItem } from "../../../shared/render-containers.ts";
import type { RenderComponent } from "../../../shared/render-dsl.ts";

// ── SectionRenderer ────────────────────────────────────────

interface SectionRendererProps {
  c: SectionComponent;
  /** Called once per visible child to produce a React element. */
  renderChild: (child: RenderComponent) => ReactElement;
  /** Dashboard-level expand/collapse state applied to all sections. */
  globalOpenState?: boolean | undefined;
}

export function SectionRenderer({ c, renderChild, globalOpenState }: SectionRendererProps): ReactElement {
  const [isOpen, setIsOpen] = useState(globalOpenState ?? c.defaultOpen ?? false);

  useEffect(() => {
    if (globalOpenState !== undefined) {
      setIsOpen(globalOpenState);
    }
  }, [globalOpenState]);

  const toggleOpen = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  return (
    <div
      style={{
        background: "var(--bg-secondary)",
        borderRadius: 8,
        border: "1px solid var(--border-default)",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={isOpen}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 14px",
          background: "var(--bg-elevated)",
          border: "none",
          borderBottom: isOpen ? "1px solid var(--border-default)" : "none",
          cursor: "pointer",
          textAlign: "left",
          color: "var(--text-primary)",
          transition: "background 0.15s ease",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            fontSize: 10,
            color: "var(--text-muted)",
            lineHeight: 1,
            flexShrink: 0,
            display: "inline-block",
            transform: isOpen ? "rotate(0deg)" : "rotate(-90deg)",
            transition: "transform 0.2s ease",
          }}
        >
          ▼
        </span>

        <span
          style={{
            flex: 1,
            fontSize: 11,
            fontWeight: 600,
            color: "var(--text-primary)",
            letterSpacing: "-0.01em",
            textAlign: "left",
          }}
        >
          {c.title}
        </span>

        {c.badge !== undefined && (
          <span
            style={{
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              color: "var(--text-muted)",
              background: "var(--bg-secondary)",
              border: "1px solid var(--border-default)",
              borderRadius: 10,
              padding: "1px 7px",
              flexShrink: 0,
              lineHeight: 1.6,
            }}
          >
            {c.badge}
          </span>
        )}
      </button>

      {isOpen && c.components.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: 10,
          }}
        >
          {c.components.map((child) => (
            <div key={child.id}>{renderChild(child)}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── TabsRenderer ───────────────────────────────────────────

interface TabsRendererProps {
  c: TabsComponent;
  /** Called once per visible child in the active tab. */
  renderChild: (child: RenderComponent) => ReactElement;
}

export function TabsRenderer({ c, renderChild }: TabsRendererProps): ReactElement {
  const firstTabId = c.tabs[0]?.id ?? "";
  const [activeTabId, setActiveTabId] = useState(c.activeTabId ?? firstTabId);
  const tablistRef = useRef<HTMLDivElement>(null);

  // Find the active tab; fall back to the first tab if the id is stale.
  const activeTab: TabItem | undefined =
    c.tabs.find((t) => t.id === activeTabId) ?? c.tabs[0];

  const handleTabKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();

      const dir = e.key === "ArrowLeft" ? -1 : 1;
      const nextIdx = (idx + dir + c.tabs.length) % c.tabs.length;
      const nextTab = c.tabs[nextIdx];
      if (!nextTab) return;

      setActiveTabId(nextTab.id);

      // Move focus to the newly activated tab button.
      const list = tablistRef.current;
      if (list) {
        const buttons = list.querySelectorAll<HTMLButtonElement>("[role='tab']");
        buttons[nextIdx]?.focus();
      }
    },
    [c.tabs],
  );

  return (
    <div
      style={{
        background: "var(--bg-secondary)",
        borderRadius: 8,
        border: "1px solid var(--border-default)",
        overflow: "hidden",
      }}
    >
      <div
        ref={tablistRef}
        role="tablist"
        style={{
          display: "flex",
          alignItems: "stretch",
          background: "var(--bg-elevated)",
          borderBottom: "1px solid var(--border-default)",
          overflowX: "auto",
        }}
      >
        {c.tabs.map((tab, idx) => {
          const isActive = tab.id === activeTabId;
          return (
            <button
              key={tab.id}
              role="tab"
              type="button"
              aria-selected={isActive}
              onClick={() => setActiveTabId(tab.id)}
              onKeyDown={(e) => handleTabKeyDown(e, idx)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 14px",
                background: "transparent",
                border: "none",
                borderBottom: isActive
                  ? "2px solid var(--accent)"
                  : "2px solid transparent",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: isActive ? 600 : 400,
                color: isActive ? "var(--text-primary)" : "var(--text-muted)",
                whiteSpace: "nowrap",
                flexShrink: 0,
                transition: "color 0.15s ease, border-color 0.15s ease",
              }}
            >
              {tab.label}
              {tab.badge !== undefined && (
                <span
                  style={{
                    fontSize: 9,
                    fontFamily: "var(--font-mono)",
                    color: isActive ? "var(--accent)" : "var(--text-muted)",
                    background: isActive
                      ? "color-mix(in srgb, var(--accent) 12%, transparent)"
                      : "var(--bg-secondary)",
                    border: isActive
                      ? "1px solid color-mix(in srgb, var(--accent) 25%, transparent)"
                      : "1px solid var(--border-default)",
                    borderRadius: 8,
                    padding: "0px 5px",
                    lineHeight: 1.8,
                    transition: "color 0.15s ease, background 0.15s ease",
                  }}
                >
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {activeTab !== undefined && activeTab.components.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: 10,
          }}
        >
          {activeTab.components.map((child) => (
            <div key={child.id}>{renderChild(child)}</div>
          ))}
        </div>
      )}
    </div>
  );
}
