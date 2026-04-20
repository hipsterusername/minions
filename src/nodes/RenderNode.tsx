/**
 * RenderNode — Agent-driven adaptive dashboard node.
 *
 * Auto-spawned and affixed to the right of a Leader node. Subscribes to
 * `render_update` WebSocket events matching its paired Leader session and
 * renders a live grid of pre-built component primitives.
 *
 * Not user-creatable from the palette — only created programmatically
 * when a Leader session starts.
 */

import { useEffect, useRef, useMemo, useCallback } from "react";
import type { NodeRenderProps } from "../types.ts";
import { registerNodeType } from "../node-registry.ts";
import type { ServerMessage } from "../use-socket.ts";
import { SimpleMarkdown } from "../components/SimpleMarkdown.tsx";
import { ResizeHandle } from "../components/ResizeHandle.tsx";
import type {
  RenderState,
  RenderComponent,
  RenderMessage,
  MetricComponent,
  ProgressComponent,
  TableComponent,
  ListComponent,
  TextComponent,
  StatusComponent,
  CodeComponent,
} from "../../shared/render-dsl.ts";
import { applyRenderMessage, emptyRenderState } from "../../shared/render-dsl.ts";

// ── Data shape ────────────────────────────────────────────

export interface RenderNodeData {
  /** Session key of the paired Leader */
  leaderSessionKey: string | null;
  /** Canvas node ID of the paired Leader (used for group-move affixing) */
  leaderId: string | null;
  /** Current render state */
  renderState: RenderState;
}

// ── Color palette ─────────────────────────────────────────

const DSL_COLORS: Record<string, string> = {
  green: "var(--status-success)",
  red: "var(--status-error)",
  yellow: "var(--status-warning)",
  blue: "var(--info-color)",
  gray: "var(--text-muted)",
  purple: "var(--thinking-accent)",
  orange: "var(--accent)",
};

const STATUS_CONFIG: Record<string, { color: string; icon: string; bg: string }> = {
  success: { color: "var(--status-success)", icon: "\u2713", bg: "var(--success-bg)" },
  error: { color: "var(--status-error)", icon: "\u2717", bg: "var(--error-bg)" },
  warning: { color: "var(--status-warning)", icon: "!", bg: "var(--warning-bg)" },
  running: { color: "var(--info-color)", icon: "\u25CB", bg: "var(--info-bg)" },
  pending: { color: "var(--text-muted)", icon: "\u2022", bg: "var(--muted-bg)" },
};

const TREND_ARROWS: Record<string, { symbol: string; color: string }> = {
  up: { symbol: "\u2191", color: "var(--status-success)" },
  down: { symbol: "\u2193", color: "var(--status-error)" },
  flat: { symbol: "\u2192", color: "var(--text-muted)" },
};

// ── Individual component renderers ────────────────────────

function MetricCard({ c }: { c: MetricComponent }) {
  const color = c.color ? DSL_COLORS[c.color] ?? "var(--info-color)" : "var(--text-primary)";
  const trend = c.trend ? TREND_ARROWS[c.trend] : null;

  return (
    <div style={{
      padding: "12px 14px",
      background: "var(--bg-secondary)",
      borderRadius: 8,
      border: "1px solid var(--border-default)",
      display: "flex",
      flexDirection: "column",
      gap: 4,
    }}>
      <div style={{
        fontSize: 11,
        color: "var(--text-muted)",
        fontFamily: "var(--font-mono)",
        textTransform: "uppercase",
        letterSpacing: 0.5,
        lineHeight: 1.2,
      }}>
        {c.label}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{
          fontSize: 22,
          fontWeight: 700,
          color,
          lineHeight: 1.1,
          fontFamily: "var(--font-mono)",
        }}>
          {c.value}
        </span>
        {trend && (
          <span style={{
            fontSize: 14,
            color: trend.color,
            fontWeight: 600,
          }}>
            {trend.symbol}
          </span>
        )}
      </div>
      {c.detail && (
        <div style={{
          fontSize: 10,
          color: "var(--text-muted)",
          lineHeight: 1.3,
        }}>
          {c.detail}
        </div>
      )}
    </div>
  );
}

function ProgressBar({ c }: { c: ProgressComponent }) {
  const color = c.color ? DSL_COLORS[c.color] ?? "var(--info-color)" : "var(--info-color)";
  const pct = Math.max(0, Math.min(100, c.value));

  return (
    <div style={{
      padding: "10px 14px",
      background: "var(--bg-secondary)",
      borderRadius: 8,
      border: "1px solid var(--border-default)",
      display: "flex",
      flexDirection: "column",
      gap: 6,
    }}>
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}>
        <span style={{
          fontSize: 11,
          color: "var(--text-secondary)",
          fontFamily: "var(--font-mono)",
        }}>
          {c.label}
        </span>
        <span style={{
          fontSize: 11,
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
        }}>
          {pct}%
        </span>
      </div>
      <div style={{
        height: 6,
        background: "var(--bg-elevated)",
        borderRadius: 3,
        overflow: "hidden",
      }}>
        <div style={{
          height: "100%",
          width: `${pct}%`,
          background: color,
          borderRadius: 3,
          transition: "width 0.3s ease",
        }} />
      </div>
    </div>
  );
}

function StatusBadge({ c }: { c: StatusComponent }) {
  const cfg = STATUS_CONFIG[c.state] ?? STATUS_CONFIG.pending;
  const isRunning = c.state === "running";

  return (
    <div style={{
      padding: "10px 14px",
      background: cfg.bg,
      borderRadius: 8,
      border: `1px solid ${cfg.color}33`,
      display: "flex",
      alignItems: "center",
      gap: 8,
    }}>
      <span style={{
        width: 20,
        height: 20,
        borderRadius: "50%",
        background: cfg.color,
        color: "var(--text-primary)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 11,
        fontWeight: 700,
        flexShrink: 0,
        ...(isRunning ? {
          animation: "render-pulse 1.5s ease-in-out infinite",
        } : {}),
      }}>
        {cfg.icon}
      </span>
      <span style={{
        fontSize: 12,
        color: "var(--text-primary)",
        fontWeight: 500,
      }}>
        {c.label}
      </span>
    </div>
  );
}

function DataTable({ c }: { c: TableComponent }) {
  return (
    <div style={{
      background: "var(--bg-secondary)",
      borderRadius: 8,
      border: "1px solid var(--border-default)",
      overflow: "hidden",
    }}>
      {c.title && (
        <div style={{
          padding: "8px 12px",
          fontSize: 11,
          fontWeight: 600,
          color: "var(--text-secondary)",
          borderBottom: "1px solid var(--border-default)",
          fontFamily: "var(--font-mono)",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}>
          {c.title}
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        <table style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 11,
          fontFamily: "var(--font-mono)",
        }}>
          <thead>
            <tr>
              {c.headers.map((h, i) => (
                <th key={i} style={{
                  padding: "6px 10px",
                  textAlign: "left",
                  color: "var(--text-muted)",
                  fontWeight: 600,
                  borderBottom: "1px solid var(--border-default)",
                  whiteSpace: "nowrap",
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {c.rows.map((row, ri) => (
              <tr key={ri} style={{
                borderBottom: ri < c.rows.length - 1 ? "1px solid var(--border-default)" : "none",
              }}>
                {row.map((cell, ci) => (
                  <td key={ci} style={{
                    padding: "5px 10px",
                    color: "var(--text-primary)",
                    whiteSpace: "nowrap",
                  }}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DataList({ c }: { c: ListComponent }) {
  const Tag = c.ordered ? "ol" : "ul";

  return (
    <div style={{
      padding: "10px 14px",
      background: "var(--bg-secondary)",
      borderRadius: 8,
      border: "1px solid var(--border-default)",
    }}>
      {c.title && (
        <div style={{
          fontSize: 11,
          fontWeight: 600,
          color: "var(--text-secondary)",
          marginBottom: 6,
          fontFamily: "var(--font-mono)",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}>
          {c.title}
        </div>
      )}
      <Tag style={{
        margin: 0,
        paddingLeft: 18,
        fontSize: 12,
        color: "var(--text-primary)",
        lineHeight: 1.6,
      }}>
        {c.items.map((item, i) => (
          <li key={i} style={{ color: "var(--text-secondary)" }}>
            <span style={{ color: "var(--text-primary)" }}>{item}</span>
          </li>
        ))}
      </Tag>
    </div>
  );
}

function TextBlock({ c }: { c: TextComponent }) {
  return (
    <div style={{
      padding: "10px 14px",
      background: "var(--bg-secondary)",
      borderRadius: 8,
      border: "1px solid var(--border-default)",
      fontSize: 12,
      color: "var(--text-primary)",
      lineHeight: 1.5,
    }}>
      <SimpleMarkdown text={c.content} />
    </div>
  );
}

function CodeBlock({ c }: { c: CodeComponent }) {
  return (
    <div style={{
      background: "var(--bg-secondary)",
      borderRadius: 8,
      border: "1px solid var(--border-default)",
      overflow: "hidden",
    }}>
      {(c.title || c.language) && (
        <div style={{
          padding: "6px 12px",
          fontSize: 10,
          color: "var(--text-muted)",
          borderBottom: "1px solid var(--border-default)",
          fontFamily: "var(--font-mono)",
          display: "flex",
          justifyContent: "space-between",
        }}>
          <span>{c.title ?? ""}</span>
          {c.language && (
            <span style={{ textTransform: "uppercase", letterSpacing: 0.5 }}>
              {c.language}
            </span>
          )}
        </div>
      )}
      <pre style={{
        margin: 0,
        padding: "10px 12px",
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        color: "var(--text-primary)",
        overflowX: "auto",
        lineHeight: 1.5,
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
      }}>
        {c.content}
      </pre>
    </div>
  );
}

// ── Component dispatcher ──────────────────────────────────

function RenderComponentView({ component }: { component: RenderComponent }) {
  switch (component.type) {
    case "metric":
      return <MetricCard c={component} />;
    case "progress":
      return <ProgressBar c={component} />;
    case "status":
      return <StatusBadge c={component} />;
    case "table":
      return <DataTable c={component} />;
    case "list":
      return <DataList c={component} />;
    case "text":
      return <TextBlock c={component} />;
    case "code":
      return <CodeBlock c={component} />;
    default:
      return null;
  }
}

// ── Determine if a component should span full width ───────

function isFullWidth(c: RenderComponent): boolean {
  return c.type === "table" || c.type === "code" || c.type === "text";
}

// ── Pulse animation (injected once) ──────────────────────

let styleInjected = false;
function injectStyles() {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    @keyframes render-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
  `;
  document.head.appendChild(style);
}

// ── Main RenderNode component ─────────────────────────────

function RenderNodeRenderer({
  node,
  onUpdateData,
  socketSubscribe,
  onResize,
  canvasScale,
}: NodeRenderProps) {
  const data = node.data as RenderNodeData;
  const dataRef = useRef(data);
  dataRef.current = data;

  // Inject CSS animation
  useEffect(() => { injectStyles(); }, []);

  // Subscribe to render_update events from the paired Leader session
  useEffect(() => {
    if (!socketSubscribe || !data.leaderSessionKey) return;

    return socketSubscribe((msg: unknown) => {
      const serverMsg = msg as ServerMessage & {
        type: string;
        leaderSessionKey?: string;
        action?: string;
        layout?: unknown;
        components?: unknown;
        updates?: unknown;
        ids?: unknown;
      };

      if (
        serverMsg.type !== "render_update" ||
        serverMsg.leaderSessionKey !== dataRef.current.leaderSessionKey
      ) {
        return;
      }

      // Build a RenderMessage from the server event
      const renderMsg: RenderMessage = serverMsg as unknown as RenderMessage;
      const newState = applyRenderMessage(dataRef.current.renderState, renderMsg);
      onUpdateData({ ...dataRef.current, renderState: newState });
    });
  }, [socketSubscribe, data.leaderSessionKey, onUpdateData]);

  const { renderState } = data;
  const { layout, components } = renderState;
  const columns = layout.columns ?? 2;
  const gap = layout.gap ?? 12;
  const hasContent = components.length > 0;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-surface)",
        borderRadius: 8,
        border: "1px solid var(--border-default)",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* Resize handle */}
      {onResize && (
        <ResizeHandle
          currentSize={node.size}
          minWidth={300}
          minHeight={200}
          onResize={onResize}
          color="var(--accent)"
          canvasScale={canvasScale}
        />
      )}

      {/* Header */}
      <div
        style={{
          padding: "6px 12px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid var(--border-default)",
          flexShrink: 0,
          background: "linear-gradient(135deg, var(--bg-surface) 0%, var(--bg-secondary) 100%)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              width: 20,
              height: 20,
              borderRadius: 5,
              background: "linear-gradient(135deg, #3b82f6, #8b5cf6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
              flexShrink: 0,
            }}
          >
            <img
              src="/icons/dashboard.svg"
              alt="Dashboard"
              width={14}
              height={14}
              style={{ display: "block" }}
            />
          </div>
          <span style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--text-primary)",
          }}>
            {layout.title || "Dashboard"}
          </span>
        </div>
        {hasContent && (
          <span style={{
            fontSize: 9,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
          }}>
            {components.length} component{components.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Content area */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: hasContent ? gap : 0,
        }}
      >
        {!hasContent ? (
          <div style={{
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            gap: 8,
            color: "var(--text-muted)",
            padding: 24,
          }}>
            <div style={{
              width: 40,
              height: 40,
              borderRadius: 10,
              background: "var(--bg-secondary)",
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
            <div style={{
              fontSize: 12,
              textAlign: "center",
              lineHeight: 1.5,
            }}>
              Waiting for dashboard data...
              <br />
              <span style={{ fontSize: 10, opacity: 0.7 }}>
                The Leader agent will populate this panel
              </span>
            </div>
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${columns}, 1fr)`,
              gap,
            }}
          >
            {components.map((c) => (
              <div
                key={c.id}
                style={{
                  gridColumn: isFullWidth(c) ? `1 / -1` : undefined,
                  minWidth: 0,
                }}
              >
                <RenderComponentView component={c} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Register ──────────────────────────────────────────────

registerNodeType({
  type: "render",
  label: "Dashboard",
  defaultSize: { width: 460, height: 500 },
  render: RenderNodeRenderer,
  userCreatable: false,  // Only auto-spawned with Leaders
});
