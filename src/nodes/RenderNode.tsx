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

import { useCallback, useEffect, useRef, useState } from "react";
import type { NodeRenderProps } from "../types.ts";
import { registerNodeType } from "../node-registry.ts";
import { CONTEXT_OUT_PORT, registerContract } from "../graph.ts";
import type { NodeInterfaceContract } from "../graph.ts";
import { flattenRenderStateToText } from "../render-flatten.ts";
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
  SparklineComponent,
  KvComponent,
  TimelineComponent,
  CalloutComponent,
  SeparatorComponent,
  DiffComponent,
  ChecklistComponent,
  TagsComponent,
  CopyableComponent,
  FormComponent as FormDslComponent,
  ChartComponent as ChartDslComponent,
  SectionComponent,
  TabsComponent,
  ImageComponent,
  FilePreviewComponent,
} from "../../shared/render-dsl.ts";
import { applyRenderMessage } from "../../shared/render-dsl.ts";
import { FormComponent } from "./render/FormComponent.tsx";
import { ChartComponent } from "./render/ChartComponent.tsx";
import {
  SectionRenderer,
  TabsRenderer,
} from "./render/ContainerComponents.tsx";
import {
  ImageRenderer,
  FilePreviewRenderer,
} from "./render/ArtifactComponents.tsx";

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

// Typed as plain literal records (not Record<string, …>) so dot access works
// under noPropertyAccessFromIndexSignature, AND lookups by a literal-keyed
// fallback like `?? STATUS_CONFIG.pending` are guaranteed defined under
// noUncheckedIndexedAccess.

type DslColorKey = "green" | "red" | "yellow" | "blue" | "gray" | "purple" | "orange";
const DSL_COLORS: { [K in DslColorKey]: string } = {
  green: "var(--status-success)",
  red: "var(--status-error)",
  yellow: "var(--status-warning)",
  blue: "var(--info-color)",
  gray: "var(--text-muted)",
  purple: "var(--thinking-accent)",
  orange: "var(--accent)",
};

type StatusKey = "success" | "error" | "warning" | "running" | "pending";
const STATUS_CONFIG: { [K in StatusKey]: { color: string; icon: string; bg: string } } = {
  success: { color: "var(--status-success)", icon: "\u2713", bg: "var(--success-bg)" },
  error: { color: "var(--status-error)", icon: "\u2717", bg: "var(--error-bg)" },
  warning: { color: "var(--status-warning)", icon: "!", bg: "var(--warning-bg)" },
  running: { color: "var(--info-color)", icon: "\u25CB", bg: "var(--info-bg)" },
  pending: { color: "var(--text-muted)", icon: "\u2022", bg: "var(--muted-bg)" },
};

type TrendKey = "up" | "down" | "flat";
const TREND_ARROWS: { [K in TrendKey]: { symbol: string; color: string } } = {
  up: { symbol: "\u2191", color: "var(--status-success)" },
  down: { symbol: "\u2193", color: "var(--status-error)" },
  flat: { symbol: "\u2192", color: "var(--text-muted)" },
};

// ── Shared CSS class names (injected via injectStyles) ────

const CLS = {
  card: "rd-card",
  cardHover: "rd-card--hover",
  tableRow: "rd-table-row",
  checkItem: "rd-check-item",
  fadeIn: "rd-fade-in",
  shimmer: "rd-shimmer",
  pulseRing: "rd-pulse-ring",
  scrollArea: "rd-scroll",
  kvRow: "rd-kv-row",
  listItem: "rd-list-item",
  tagPill: "rd-tag-pill",
} as const;

// ── Individual component renderers ────────────────────────

function MetricCard({ c }: { c: MetricComponent }) {
  const color = c.color ? DSL_COLORS[c.color] ?? "var(--info-color)" : undefined;
  const trend = c.trend ? TREND_ARROWS[c.trend] : null;

  return (
    <div
      className={`${CLS.card} ${CLS.cardHover} ${CLS.fadeIn}`}
      style={{
        padding: "14px 16px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Accent bar at top — only when color is specified */}
      {color && (
        <div style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          background: color,
          opacity: 0.7,
        }} />
      )}
      <div style={{
        fontSize: 10,
        color: "var(--text-muted)",
        fontFamily: "var(--font-mono)",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        lineHeight: 1.2,
        fontWeight: 500,
      }}>
        {c.label}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 2 }}>
        <span style={{
          fontSize: 24,
          fontWeight: 700,
          color: color ?? "var(--text-primary)",
          lineHeight: 1.1,
          fontFamily: "var(--font-mono)",
          letterSpacing: "-0.02em",
        }}>
          {c.value}
        </span>
        {trend && (
          <span style={{
            fontSize: 14,
            color: trend.color,
            fontWeight: 600,
            lineHeight: 1,
          }}>
            {trend.symbol}
          </span>
        )}
      </div>
      {c.detail && (
        <div style={{
          fontSize: 10,
          color: "var(--text-muted)",
          lineHeight: 1.4,
          marginTop: 2,
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
  const isComplete = pct >= 100;

  return (
    <div
      className={`${CLS.card} ${CLS.fadeIn}`}
      style={{
        padding: "12px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
      }}>
        <span style={{
          fontSize: 10,
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontWeight: 500,
        }}>
          {c.label}
        </span>
        <span style={{
          fontSize: 12,
          color: isComplete ? color : "var(--text-secondary)",
          fontFamily: "var(--font-mono)",
          fontWeight: 600,
        }}>
          {pct}%
        </span>
      </div>
      <div style={{
        height: 6,
        background: "var(--bg-elevated)",
        borderRadius: 3,
        overflow: "hidden",
        boxShadow: "inset 0 1px 2px rgba(0,0,0,0.15)",
      }}>
        <div
          className={!isComplete ? CLS.shimmer : undefined}
          style={{
            height: "100%",
            width: `${pct}%`,
            background: isComplete
              ? color
              : `linear-gradient(90deg, ${color}, color-mix(in srgb, ${color} 75%, white))`,
            borderRadius: 3,
            transition: "width 0.4s cubic-bezier(0.4, 0, 0.2, 1)",
            position: "relative",
          }}
        />
      </div>
    </div>
  );
}

function StatusBadge({ c }: { c: StatusComponent }) {
  const cfg = STATUS_CONFIG[c.state] ?? STATUS_CONFIG.pending;
  const isRunning = c.state === "running";

  return (
    <div
      className={`${CLS.card} ${CLS.fadeIn}`}
      style={{
        padding: "10px 14px",
        background: cfg.bg,
        borderColor: `color-mix(in srgb, ${cfg.color} 20%, transparent)`,
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      <span style={{ position: "relative", flexShrink: 0 }}>
        {/* Pulse ring for running state */}
        {isRunning && (
          <span
            className={CLS.pulseRing}
            style={{
              position: "absolute",
              inset: -3,
              borderRadius: "50%",
              border: `1.5px solid ${cfg.color}`,
            }}
          />
        )}
        <span style={{
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: `color-mix(in srgb, ${cfg.color} 18%, transparent)`,
          border: `1.5px solid ${cfg.color}`,
          color: cfg.color,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 10,
          fontWeight: 700,
          ...(isRunning ? {
            animation: "render-pulse 2s ease-in-out infinite",
          } : {}),
        }}>
          {cfg.icon}
        </span>
      </span>
      <span style={{
        fontSize: 12,
        color: "var(--text-primary)",
        fontWeight: 500,
        lineHeight: 1.3,
      }}>
        {c.label}
      </span>
    </div>
  );
}

function DataTable({ c }: { c: TableComponent }) {
  return (
    <div className={`${CLS.card} ${CLS.fadeIn}`} style={{ overflow: "hidden", padding: 0 }}>
      {c.title && (
        <div style={{
          padding: "8px 14px",
          fontSize: 10,
          fontWeight: 600,
          color: "var(--text-muted)",
          borderBottom: "1px solid var(--border-default)",
          fontFamily: "var(--font-mono)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          background: "var(--bg-elevated)",
        }}>
          {c.title}
        </div>
      )}
      <div style={{ overflowX: "auto" }} className={CLS.scrollArea}>
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
                  padding: "8px 14px 7px",
                  textAlign: "left",
                  color: "var(--text-muted)",
                  fontWeight: 600,
                  borderBottom: "1px solid var(--border-default)",
                  whiteSpace: "nowrap",
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  background: "var(--bg-elevated)",
                }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {c.rows.map((row, ri) => (
              <tr
                key={ri}
                className={CLS.tableRow}
                style={{
                  borderBottom: ri < c.rows.length - 1 ? "1px solid var(--border-default)" : "none",
                  background: ri % 2 === 1 ? "var(--state-hover)" : "transparent",
                }}
              >
                {row.map((cell, ci) => (
                  <td key={ci} style={{
                    padding: "6px 14px",
                    color: ci === 0 ? "var(--text-primary)" : "var(--text-secondary)",
                    fontWeight: ci === 0 ? 500 : 400,
                    whiteSpace: "nowrap",
                    lineHeight: 1.5,
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
  return (
    <div className={`${CLS.card} ${CLS.fadeIn}`} style={{ padding: 0, overflow: "hidden" }}>
      {c.title && (
        <div style={{
          padding: "8px 14px",
          fontSize: 10,
          fontWeight: 600,
          color: "var(--text-muted)",
          borderBottom: "1px solid var(--border-default)",
          fontFamily: "var(--font-mono)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          background: "var(--bg-elevated)",
        }}>
          {c.title}
        </div>
      )}
      <div style={{ padding: "8px 0" }}>
        {c.items.map((item, i) => (
          <div
            key={i}
            className={CLS.listItem}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 10,
              padding: "4px 14px",
              fontSize: 12,
              lineHeight: 1.6,
              color: "var(--text-primary)",
            }}
          >
            <span style={{
              color: c.ordered ? "var(--text-muted)" : "var(--accent)",
              fontFamily: "var(--font-mono)",
              fontSize: c.ordered ? 10 : 6,
              fontWeight: 600,
              flexShrink: 0,
              width: c.ordered ? 18 : "auto",
              textAlign: "right",
              lineHeight: "inherit",
              userSelect: "none",
            }}>
              {c.ordered ? `${i + 1}.` : "\u25CF"}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>{item}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TextBlock({ c }: { c: TextComponent }) {
  return (
    <div
      className={`${CLS.card} ${CLS.fadeIn}`}
      style={{
        padding: "12px 16px",
        fontSize: 12,
        color: "var(--text-primary)",
        lineHeight: 1.6,
      }}
    >
      <SimpleMarkdown text={c.content} />
    </div>
  );
}

function CodeBlock({ c }: { c: CodeComponent }) {
  return (
    <div className={`${CLS.card} ${CLS.fadeIn}`} style={{ overflow: "hidden", padding: 0 }}>
      {(c.title || c.language) && (
        <div style={{
          padding: "6px 14px",
          fontSize: 10,
          color: "var(--text-muted)",
          borderBottom: "1px solid var(--border-default)",
          fontFamily: "var(--font-mono)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          background: "var(--bg-elevated)",
        }}>
          <span style={{ fontWeight: 500 }}>{c.title ?? ""}</span>
          {c.language && (
            <span style={{
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              fontSize: 9,
              padding: "1px 6px",
              borderRadius: 3,
              background: "var(--code-bg)",
              color: "var(--accent)",
              fontWeight: 600,
            }}>
              {c.language}
            </span>
          )}
        </div>
      )}
      <pre
        className={CLS.scrollArea}
        style={{
          margin: 0,
          padding: "12px 14px",
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          color: "var(--text-primary)",
          overflowX: "auto",
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          tabSize: 2,
        }}
      >
        {c.content}
      </pre>
    </div>
  );
}

// ── New component renderers (Beautiful Evidence) ─────────

/**
 * Sparkline — Tufte's "intense, simple, word-sized graphic."
 * Pure SVG micro-chart. No axes, no gridlines — just data.
 */
function SparklineChart({ c }: { c: SparklineComponent }) {
  const color = c.color ? DSL_COLORS[c.color] ?? "var(--info-color)" : "var(--info-color)";
  const h = c.height ?? 32;
  const variant = c.variant ?? "line";
  const data = c.data;

  if (data.length === 0) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const viewW = 200;
  const viewH = h;
  const pad = 2;
  const usableH = viewH - pad * 2;
  const step = data.length > 1 ? (viewW - pad * 2) / (data.length - 1) : 0;

  const points = data.map((v, i) => ({
    x: pad + i * step,
    y: pad + usableH - ((v - min) / range) * usableH,
  }));

  const polyline = points.map((p) => `${p.x},${p.y}`).join(" ");

  // Area path for area variant (or subtle fill for line variant)
  const areaPath = `M${points[0]!.x},${points[0]!.y} ` +
    points.slice(1).map((p) => `L${p.x},${p.y}`).join(" ") +
    ` L${points[points.length - 1]!.x},${viewH - pad} L${points[0]!.x},${viewH - pad} Z`;

  // Reference line
  const refY = c.referenceValue != null
    ? pad + usableH - ((c.referenceValue - min) / range) * usableH
    : null;

  return (
    <div
      className={`${CLS.card} ${CLS.fadeIn}`}
      style={{
        padding: "12px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {c.label && (
        <div style={{
          fontSize: 10,
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontWeight: 500,
        }}>
          {c.label}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <svg
          viewBox={`0 0 ${viewW} ${viewH}`}
          width="100%"
          height={h}
          preserveAspectRatio="none"
          style={{ display: "block", flex: 1 }}
        >
          {/* Reference line */}
          {refY != null && (
            <line
              x1={pad} y1={refY} x2={viewW - pad} y2={refY}
              stroke="var(--text-muted)"
              strokeWidth="0.5"
              strokeDasharray="3,3"
              opacity={0.4}
            />
          )}

          {variant === "bar" ? (
            data.map((v, i) => {
              const barW = Math.max(1, (viewW - pad * 2) / data.length - 1.5);
              const barH = ((v - min) / range) * usableH;
              const x = pad + i * ((viewW - pad * 2) / data.length);
              return (
                <rect
                  key={i}
                  x={x}
                  y={viewH - pad - barH}
                  width={barW}
                  height={barH}
                  fill={color}
                  opacity={0.75}
                  rx={1}
                />
              );
            })
          ) : (
            <>
              {/* Subtle area fill for both line and area variants */}
              <path
                d={areaPath}
                fill={color}
                opacity={variant === "area" ? 0.15 : 0.06}
              />
              <polyline
                points={polyline}
                fill="none"
                stroke={color}
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </>
          )}

          {/* Endpoint dots */}
          {variant !== "bar" && points.length > 1 && (
            <>
              <circle cx={points[0]!.x} cy={points[0]!.y} r="2" fill={color} opacity={0.5} />
              <circle cx={points[points.length - 1]!.x} cy={points[points.length - 1]!.y} r="2.5" fill={color} />
            </>
          )}
        </svg>

        {/* Min/max range labels */}
        {c.showRange && (
          <div style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            height: h,
            fontSize: 9,
            fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
            flexShrink: 0,
            lineHeight: 1,
            opacity: 0.7,
          }}>
            <span>{max}</span>
            <span>{min}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * KeyValueSheet — dense property list. Alternating rows,
 * clear key-value separation. Supports horizontal layout.
 */
function KeyValueSheet({ c }: { c: KvComponent }) {
  const isHorizontal = c.layout === "horizontal";

  return (
    <div className={`${CLS.card} ${CLS.fadeIn}`} style={{ overflow: "hidden", padding: 0 }}>
      {c.title && (
        <div style={{
          padding: "8px 14px",
          fontSize: 10,
          fontWeight: 600,
          color: "var(--text-muted)",
          borderBottom: "1px solid var(--border-default)",
          fontFamily: "var(--font-mono)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          background: "var(--bg-elevated)",
        }}>
          {c.title}
        </div>
      )}
      <div style={{
        display: isHorizontal ? "flex" : "block",
        flexWrap: isHorizontal ? "wrap" : undefined,
      }}>
        {c.entries.map((entry, i) => {
          const valColor = entry.color ? DSL_COLORS[entry.color] ?? "var(--text-primary)" : "var(--text-primary)";

          if (isHorizontal) {
            return (
              <div key={i} style={{
                padding: "10px 14px",
                borderRight: i < c.entries.length - 1 ? "1px solid var(--border-default)" : "none",
                display: "flex",
                flexDirection: "column",
                gap: 3,
                flex: "1 1 auto",
                minWidth: 80,
              }}>
                <span style={{
                  fontSize: 9,
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  fontWeight: 500,
                }}>
                  {entry.key}
                </span>
                <span style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: valColor,
                  fontFamily: "var(--font-mono)",
                  letterSpacing: "-0.01em",
                }}>
                  {entry.value}
                </span>
              </div>
            );
          }

          return (
            <div
              key={i}
              className={CLS.kvRow}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                padding: "6px 14px",
                borderBottom: i < c.entries.length - 1 ? "1px solid var(--border-default)" : "none",
                gap: 12,
                background: i % 2 === 1 ? "var(--state-hover)" : "transparent",
              }}
            >
              <span style={{
                fontSize: 11,
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                flexShrink: 0,
              }}>
                {entry.key}
              </span>
              <span style={{
                fontSize: 11,
                color: valColor,
                fontFamily: "var(--font-mono)",
                fontWeight: 500,
                textAlign: "right",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>
                {entry.value}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * TimelineView — vertical sequence with state-colored dots and connector line.
 * Compact and scannable for event history.
 */
function TimelineView({ c }: { c: TimelineComponent }) {
  return (
    <div className={`${CLS.card} ${CLS.fadeIn}`} style={{ overflow: "hidden", padding: 0 }}>
      {c.title && (
        <div style={{
          padding: "8px 14px",
          fontSize: 10,
          fontWeight: 600,
          color: "var(--text-muted)",
          borderBottom: "1px solid var(--border-default)",
          fontFamily: "var(--font-mono)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          background: "var(--bg-elevated)",
        }}>
          {c.title}
        </div>
      )}
      <div style={{ padding: "12px 14px" }}>
        {c.events.map((event, i) => {
          const cfg = STATUS_CONFIG[event.state ?? "pending"] ?? STATUS_CONFIG.pending;
          const isLast = i === c.events.length - 1;
          const isRunning = event.state === "running";

          return (
            <div key={i} style={{
              display: "flex",
              gap: 12,
              minHeight: isLast ? "auto" : 40,
            }}>
              {/* Connector column: dot + line */}
              <div style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                width: 16,
                flexShrink: 0,
              }}>
                <div style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: `color-mix(in srgb, ${cfg.color} 20%, transparent)`,
                  border: `2px solid ${cfg.color}`,
                  flexShrink: 0,
                  marginTop: 3,
                  boxSizing: "border-box",
                  ...(isRunning ? {
                    animation: "render-pulse 2s ease-in-out infinite",
                    background: cfg.color,
                  } : {}),
                }} />
                {!isLast && (
                  <div style={{
                    width: 1.5,
                    flex: 1,
                    background: `color-mix(in srgb, ${cfg.color} 25%, var(--border-default))`,
                    marginTop: 3,
                    marginBottom: 3,
                    borderRadius: 1,
                  }} />
                )}
              </div>
              {/* Content column */}
              <div style={{
                flex: 1,
                paddingBottom: isLast ? 0 : 8,
                minWidth: 0,
              }}>
                <div style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  gap: 8,
                }}>
                  <span style={{
                    fontSize: 11,
                    fontWeight: 500,
                    color: "var(--text-primary)",
                    lineHeight: 1.3,
                  }}>
                    {event.label}
                  </span>
                  {event.time && (
                    <span style={{
                      fontSize: 9,
                      color: "var(--text-muted)",
                      fontFamily: "var(--font-mono)",
                      flexShrink: 0,
                      whiteSpace: "nowrap",
                      opacity: 0.7,
                    }}>
                      {event.time}
                    </span>
                  )}
                </div>
                {event.detail && (
                  <div style={{
                    fontSize: 10,
                    color: "var(--text-muted)",
                    lineHeight: 1.5,
                    marginTop: 3,
                  }}>
                    {event.detail}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Callout variant configuration */
type CalloutVariant = "info" | "warning" | "success" | "error";
const CALLOUT_CONFIG: { [K in CalloutVariant]: { color: string; bg: string; icon: string } } = {
  info: { color: "var(--info-color)", bg: "var(--info-bg)", icon: "\u2139" },
  warning: { color: "var(--status-warning)", bg: "var(--warning-bg)", icon: "\u26A0" },
  success: { color: "var(--status-success)", bg: "var(--success-bg)", icon: "\u2713" },
  error: { color: "var(--status-error)", bg: "var(--error-bg)", icon: "\u2717" },
};

/**
 * CalloutBlock — semantic emphasis with colored left border and icon.
 * Highlights key findings, warnings, or important notes.
 */
function CalloutBlock({ c }: { c: CalloutComponent }) {
  const cfg = CALLOUT_CONFIG[c.variant] ?? CALLOUT_CONFIG.info;

  return (
    <div
      className={CLS.fadeIn}
      style={{
        background: cfg.bg,
        borderRadius: 8,
        border: `1px solid color-mix(in srgb, ${cfg.color} 15%, transparent)`,
        borderLeft: `3px solid ${cfg.color}`,
        padding: "12px 16px",
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
      }}
    >
      <span style={{
        width: 20,
        height: 20,
        borderRadius: 5,
        background: `color-mix(in srgb, ${cfg.color} 15%, transparent)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 11,
        lineHeight: 1,
        flexShrink: 0,
        color: cfg.color,
        fontWeight: 700,
      }}>
        {cfg.icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {c.title && (
          <div style={{
            fontSize: 11,
            fontWeight: 700,
            color: cfg.color,
            marginBottom: 4,
            lineHeight: 1.3,
          }}>
            {c.title}
          </div>
        )}
        <div style={{
          fontSize: 11,
          color: "var(--text-primary)",
          lineHeight: 1.6,
        }}>
          <SimpleMarkdown text={c.content} />
        </div>
      </div>
    </div>
  );
}

/**
 * SeparatorLine — visual divider with optional centered label.
 * Provides section breaks and visual breathing room.
 */
function SeparatorLine({ c }: { c: SeparatorComponent }) {
  if (c.label) {
    return (
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "6px 0",
      }}>
        <div style={{
          flex: 1,
          height: 1,
          background: "var(--border-default)",
        }} />
        <span style={{
          fontSize: 9,
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          flexShrink: 0,
          fontWeight: 500,
          opacity: 0.7,
        }}>
          {c.label}
        </span>
        <div style={{
          flex: 1,
          height: 1,
          background: "var(--border-default)",
        }} />
      </div>
    );
  }

  return (
    <div style={{
      height: 1,
      background: "var(--border-default)",
      margin: "6px 0",
    }} />
  );
}

/**
 * DiffView — side-by-side before/after comparison.
 * Color-coded columns for change evidence.
 */
function DiffView({ c }: { c: DiffComponent }) {
  return (
    <div className={`${CLS.card} ${CLS.fadeIn}`} style={{ overflow: "hidden", padding: 0 }}>
      {c.title && (
        <div style={{
          padding: "8px 14px",
          fontSize: 10,
          fontWeight: 600,
          color: "var(--text-muted)",
          borderBottom: "1px solid var(--border-default)",
          fontFamily: "var(--font-mono)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          background: "var(--bg-elevated)",
        }}>
          {c.title}
        </div>
      )}
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 0,
      }}>
        {/* Before column */}
        <div style={{
          borderRight: "1px solid var(--border-default)",
          background: `color-mix(in srgb, var(--status-error) 4%, transparent)`,
        }}>
          <div style={{
            padding: "6px 12px",
            fontSize: 9,
            color: "var(--status-error)",
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            fontWeight: 600,
            borderBottom: "1px solid var(--border-default)",
            display: "flex",
            alignItems: "center",
            gap: 5,
          }}>
            <span style={{ fontSize: 8 }}>{"\u2212"}</span>
            {c.before.label ?? "Before"}
          </div>
          <pre
            className={CLS.scrollArea}
            style={{
              margin: 0,
              padding: "10px 12px",
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              color: "var(--text-primary)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              lineHeight: 1.6,
            }}
          >
            {c.before.content}
          </pre>
        </div>
        {/* After column */}
        <div style={{
          background: `color-mix(in srgb, var(--status-success) 4%, transparent)`,
        }}>
          <div style={{
            padding: "6px 12px",
            fontSize: 9,
            color: "var(--status-success)",
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            fontWeight: 600,
            borderBottom: "1px solid var(--border-default)",
            display: "flex",
            alignItems: "center",
            gap: 5,
          }}>
            <span style={{ fontSize: 8 }}>+</span>
            {c.after.label ?? "After"}
          </div>
          <pre
            className={CLS.scrollArea}
            style={{
              margin: 0,
              padding: "10px 12px",
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              color: "var(--text-primary)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              lineHeight: 1.6,
            }}
          >
            {c.after.content}
          </pre>
        </div>
      </div>
    </div>
  );
}

/**
 * ChecklistView — task list with completion indicators.
 * Checked items get a subtle strikethrough and dimmed color.
 */
function ChecklistView({ c }: { c: ChecklistComponent }) {
  const done = c.items.filter((i) => i.checked).length;
  const total = c.items.length;
  const isComplete = total > 0 && done === total;

  return (
    <div className={`${CLS.card} ${CLS.fadeIn}`} style={{ overflow: "hidden", padding: 0 }}>
      {(c.title || total > 0) && (
        <div style={{
          padding: "8px 14px",
          fontSize: 10,
          fontWeight: 600,
          color: "var(--text-muted)",
          borderBottom: "1px solid var(--border-default)",
          fontFamily: "var(--font-mono)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          background: "var(--bg-elevated)",
        }}>
          <span style={{ textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {c.title ?? "Checklist"}
          </span>
          <span style={{
            fontSize: 10,
            color: isComplete ? "var(--status-success)" : "var(--text-muted)",
            fontWeight: 600,
            transition: "color 0.3s ease",
          }}>
            {done}/{total}
          </span>
        </div>
      )}
      {/* Progress micro-bar */}
      {total > 0 && (
        <div style={{
          height: 2,
          background: "var(--bg-elevated)",
        }}>
          <div style={{
            height: "100%",
            width: `${(done / total) * 100}%`,
            background: isComplete ? "var(--status-success)" : "var(--info-color)",
            transition: "width 0.4s cubic-bezier(0.4, 0, 0.2, 1), background 0.3s ease",
          }} />
        </div>
      )}
      <div style={{ padding: "6px 0" }}>
        {c.items.map((item, i) => (
          <div
            key={i}
            className={CLS.checkItem}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              padding: "5px 14px",
              fontSize: 11,
              color: item.checked ? "var(--text-muted)" : "var(--text-primary)",
              lineHeight: 1.5,
              transition: "color 0.2s ease",
            }}
          >
            <span style={{
              width: 16,
              height: 16,
              borderRadius: 4,
              border: item.checked
                ? "1.5px solid var(--status-success)"
                : "1.5px solid var(--border-hover)",
              background: item.checked
                ? "color-mix(in srgb, var(--status-success) 15%, transparent)"
                : "transparent",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              marginTop: 1,
              fontSize: 9,
              color: "var(--status-success)",
              fontWeight: 700,
              transition: "all 0.2s ease",
            }}>
              {item.checked ? "\u2713" : ""}
            </span>
            <span style={{
              textDecoration: item.checked ? "line-through" : "none",
              opacity: item.checked ? 0.55 : 1,
              transition: "opacity 0.2s ease",
              flex: 1,
              minWidth: 0,
            }}>
              {item.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * TagsRow — compact flex-wrapped row of categorical badges.
 * Each tag is a small rounded pill with optional color coding.
 */
function TagsRow({ c }: { c: TagsComponent }) {
  return (
    <div
      className={`${CLS.card} ${CLS.fadeIn}`}
      style={{
        padding: "12px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {c.label && (
        <div style={{
          fontSize: 10,
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontWeight: 500,
        }}>
          {c.label}
        </div>
      )}
      <div style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 5,
      }}>
        {c.items.map((tag, i) => {
          const color = tag.color ? DSL_COLORS[tag.color] ?? "var(--text-muted)" : "var(--text-muted)";
          return (
            <span
              key={i}
              className={CLS.tagPill}
              style={{
                padding: "3px 9px",
                borderRadius: 10,
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                fontWeight: 500,
                color,
                background: `color-mix(in srgb, ${color} 10%, transparent)`,
                border: `1px solid color-mix(in srgb, ${color} 20%, transparent)`,
                whiteSpace: "nowrap",
                letterSpacing: "0.01em",
                lineHeight: 1.4,
              }}
            >
              {tag.text}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/**
 * CopyableBlock — labeled text with a click-to-copy affordance.
 *
 * Designed for content the user is likely to paste somewhere else: a
 * generated command, URL, hash, snippet, error message, etc. The whole
 * block acts as a copy target plus an explicit button so the affordance
 * is visible.
 */
function CopyableBlock({ c }: { c: CopyableComponent }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-pick layout: explicit `variant` wins, otherwise multi-line or
  // long content renders as a block; short single-line as inline.
  const isBlock =
    c.variant === "block" ||
    (c.variant !== "inline" &&
      (c.content.includes("\n") || c.content.length > 60));

  const onCopy = useCallback(async () => {
    try {
      // Prefer the async clipboard API; fall back to a hidden textarea
      // so non-secure contexts (older Electron, http://) still work.
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(c.content);
      } else {
        const ta = document.createElement("textarea");
        ta.value = c.content;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn("[copyable] clipboard write failed:", err);
    }
  }, [c.content]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const copyButton = (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? "Copied" : "Copy to clipboard"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "3px 8px",
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: copied ? "var(--status-success)" : "var(--accent)",
        background: copied
          ? "color-mix(in srgb, var(--status-success) 12%, transparent)"
          : "color-mix(in srgb, var(--accent) 10%, transparent)",
        border: copied
          ? "1px solid color-mix(in srgb, var(--status-success) 35%, transparent)"
          : "1px solid color-mix(in srgb, var(--accent) 25%, transparent)",
        borderRadius: 4,
        cursor: "pointer",
        flexShrink: 0,
        transition: "color 0.2s ease, background 0.2s ease, border-color 0.2s ease",
      }}
    >
      <span style={{ fontSize: 10, lineHeight: 1 }}>
        {copied ? "✓" : "⎘"}
      </span>
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );

  return (
    <div className={`${CLS.card} ${CLS.fadeIn}`} style={{ overflow: "hidden", padding: 0 }}>
      {(c.label || c.description) && (
        <div style={{
          padding: "8px 14px",
          borderBottom: "1px solid var(--border-default)",
          background: "var(--bg-elevated)",
          display: "flex",
          flexDirection: "column",
          gap: 3,
        }}>
          {c.label && (
            <div style={{
              fontSize: 10,
              fontWeight: 600,
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}>
              {c.label}
            </div>
          )}
          {c.description && (
            <div style={{
              fontSize: 11,
              color: "var(--text-secondary)",
              lineHeight: 1.5,
            }}>
              {c.description}
            </div>
          )}
        </div>
      )}
      {isBlock ? (
        <div style={{ position: "relative" }}>
          {/* Floating copy button in top-right of block */}
          <div style={{
            position: "absolute",
            top: 8,
            right: 8,
            display: "flex",
            alignItems: "center",
            gap: 6,
            zIndex: 1,
          }}>
            {c.language && (
              <span style={{
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                fontSize: 9,
                padding: "1px 6px",
                borderRadius: 3,
                background: "var(--code-bg)",
                color: "var(--accent)",
                fontWeight: 600,
                fontFamily: "var(--font-mono)",
              }}>
                {c.language}
              </span>
            )}
            {copyButton}
          </div>
          <pre
            className={CLS.scrollArea}
            style={{
              margin: 0,
              padding: "12px 14px",
              paddingRight: 90,
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              color: "var(--text-primary)",
              overflowX: "auto",
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              tabSize: 2,
              userSelect: "all",
            }}
          >
            {c.content}
          </pre>
        </div>
      ) : (
        <div style={{
          padding: "10px 12px",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}>
          <code
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              color: "var(--text-primary)",
              background: "var(--code-bg, var(--bg-elevated))",
              padding: "5px 9px",
              borderRadius: 4,
              border: "1px solid var(--border-default)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              userSelect: "all",
              lineHeight: 1.5,
            }}
            title={c.content}
          >
            {c.content}
          </code>
          {copyButton}
        </div>
      )}
    </div>
  );
}

// ── Component dispatcher ──────────────────────────────────

/**
 * Per-render context passed down through the dispatcher. Lets interactive
 * components (form) reach back to the WebSocket and lets containers
 * (section, tabs) recursively render their children with the same context.
 */
export interface RenderViewContext {
  /**
   * Fired when a `form` component is submitted. The dashboard sends the
   * answers to the server via `submit_form` so the agent receives them as
   * a synthetic user turn.
   */
  onSubmitForm?: ((componentId: string, answers: Record<string, unknown>) => void) | undefined;
}

export function RenderComponentView({
  component,
  context,
}: {
  component: RenderComponent;
  context?: RenderViewContext | undefined;
}) {
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
    case "sparkline":
      return <SparklineChart c={component} />;
    case "kv":
      return <KeyValueSheet c={component} />;
    case "timeline":
      return <TimelineView c={component} />;
    case "callout":
      return <CalloutBlock c={component} />;
    case "separator":
      return <SeparatorLine c={component} />;
    case "diff":
      return <DiffView c={component} />;
    case "checklist":
      return <ChecklistView c={component} />;
    case "tags":
      return <TagsRow c={component} />;
    case "copyable":
      return <CopyableBlock c={component} />;
    case "form":
      return (
        <FormComponent
          component={component as FormDslComponent}
          onSubmit={(answers) => {
            context?.onSubmitForm?.(component.id, answers);
          }}
        />
      );
    case "chart":
      return <ChartComponent component={component as ChartDslComponent} />;
    case "section":
      return (
        <SectionRenderer
          c={component as SectionComponent}
          renderChild={(child) => (
            <RenderComponentView component={child} context={context} />
          )}
        />
      );
    case "tabs":
      return (
        <TabsRenderer
          c={component as TabsComponent}
          renderChild={(child) => (
            <RenderComponentView component={child} context={context} />
          )}
        />
      );
    case "image":
      return <ImageRenderer c={component as ImageComponent} />;
    case "file-preview":
      return <FilePreviewRenderer c={component as FilePreviewComponent} />;
    default:
      return null;
  }
}

// ── Determine if a component should span full width ───────
//
// Precedence:
//   1. Explicit `span` override on the component (agent opt-in)
//   2. Intrinsically full-width types (structurally wide content)
//   3. Length-based promotion for cell-width primitives whose content
//      would otherwise leave unavoidable negative space next to shorter
//      neighbors (see dashboard audit).
//
// Length thresholds are intentionally conservative — agents that want
// a different balance can use the `span` override.

const ALWAYS_FULL_WIDTH = new Set<RenderComponent["type"]>([
  "table",
  "code",
  "text",
  "list",
  "timeline",
  "diff",
  "separator",
  "callout",
  // New families: forms, charts, containers, and large artifacts are
  // intrinsically wide. Agents can still narrow with an explicit `span`.
  "form",
  "chart",
  "section",
  "tabs",
  "image",
  "file-preview",
]);

function isFullWidth(c: RenderComponent, columns: number): boolean {
  // 1. Explicit span override wins
  if (c.span === "full") return true;
  if (typeof c.span === "number") return c.span >= columns;

  // 2. Intrinsic width
  if (ALWAYS_FULL_WIDTH.has(c.type)) return true;

  // 3. Length-based promotion
  switch (c.type) {
    case "checklist":
      return c.items.length >= 6;
    case "kv":
      return (c.layout ?? "vertical") === "vertical" && c.entries.length >= 6;
    case "tags":
      return c.items.length >= 9;
    case "sparkline":
      return c.data.length >= 40;
    case "copyable":
      // Promote to full width whenever the content needs a real block:
      // explicit "block" variant, multi-line, or longer than a row of inline text.
      return (
        c.variant === "block" ||
        (c.variant !== "inline" &&
          (c.content.includes("\n") || c.content.length > 60))
      );
    default:
      return false;
  }
}

/**
 * Compute explicit column span for a component.
 * Returns a `gridColumn` CSS value or `undefined` to let auto-placement decide.
 */
export function gridColumnFor(c: RenderComponent, columns: number): string | undefined {
  if (isFullWidth(c, columns)) return "1 / -1";
  // Numeric span less than columns → span that many
  if (typeof c.span === "number" && c.span > 1 && c.span < columns) {
    return `span ${c.span}`;
  }
  return undefined;
}

// ── CSS injection ────────────────────────────────────────

let styleInjected = false;
export function injectStyles() {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    /* ── Dashboard component base card ── */
    .${CLS.card} {
      background: var(--bg-secondary);
      border-radius: 8px;
      border: 1px solid var(--border-default);
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }

    .${CLS.cardHover}:hover {
      border-color: var(--border-hover);
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    }

    /* ── Fade-in animation ── */
    .${CLS.fadeIn} {
      animation: render-fadeIn 0.25s ease-out both;
    }

    @keyframes render-fadeIn {
      from {
        opacity: 0;
        transform: translateY(4px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    /* ── Pulse animation ── */
    @keyframes render-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    /* ── Pulse ring (expanding circle) for running status ── */
    .${CLS.pulseRing} {
      animation: render-ring 2s cubic-bezier(0, 0, 0.2, 1) infinite;
    }

    @keyframes render-ring {
      0% {
        transform: scale(0.8);
        opacity: 0.6;
      }
      100% {
        transform: scale(1.8);
        opacity: 0;
      }
    }

    /* ── Shimmer for active progress bars ── */
    .${CLS.shimmer}::after {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(
        90deg,
        transparent,
        rgba(255,255,255,0.12),
        transparent
      );
      animation: render-shimmer 2s ease-in-out infinite;
    }

    @keyframes render-shimmer {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(100%); }
    }

    /* ── Table row hover ── */
    .${CLS.tableRow} {
      transition: background 0.15s ease;
    }
    .${CLS.tableRow}:hover {
      background: var(--state-hover) !important;
    }

    /* ── KV row hover ── */
    .${CLS.kvRow} {
      transition: background 0.15s ease;
    }
    .${CLS.kvRow}:hover {
      background: var(--state-active) !important;
    }

    /* ── List item hover ── */
    .${CLS.listItem} {
      transition: background 0.15s ease;
      border-radius: 4px;
    }
    .${CLS.listItem}:hover {
      background: var(--state-hover);
    }

    /* ── Checklist item hover ── */
    .${CLS.checkItem} {
      transition: background 0.15s ease;
    }
    .${CLS.checkItem}:hover {
      background: var(--state-hover);
    }

    /* ── Tag pill hover ── */
    .${CLS.tagPill} {
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .${CLS.tagPill}:hover {
      transform: translateY(-1px);
      box-shadow: 0 2px 6px rgba(0,0,0,0.1);
    }

    /* ── Scrollbar styling for dashboard areas ── */
    .${CLS.scrollArea}::-webkit-scrollbar {
      width: 5px;
      height: 5px;
    }
    .${CLS.scrollArea}::-webkit-scrollbar-track {
      background: transparent;
    }
    .${CLS.scrollArea}::-webkit-scrollbar-thumb {
      background: var(--border-hover);
      border-radius: 3px;
    }
    .${CLS.scrollArea}::-webkit-scrollbar-thumb:hover {
      background: var(--text-muted);
    }

    /* ── Responsive columns via container queries ───────
       The agent-declared \`--rd-max-cols\` is treated as a maximum.
       The actual column count (\`--rd-cols\`) steps down as the
       dashboard container narrows so long lists and other items
       don't get squeezed into unreadable columns. */
    .rd-grid-container {
      container-type: inline-size;
    }
    .rd-grid {
      /* Default: use the agent-declared max */
      --rd-cols: var(--rd-max-cols, 2);
    }
    /* Below ~720px: cap at 3 */
    @container (max-width: 720px) {
      .rd-grid { --rd-cols: min(var(--rd-max-cols, 2), 3); }
    }
    /* Below ~520px: cap at 2 */
    @container (max-width: 520px) {
      .rd-grid { --rd-cols: min(var(--rd-max-cols, 2), 2); }
    }
    /* Below ~360px: collapse to single column */
    @container (max-width: 360px) {
      .rd-grid { --rd-cols: 1; }
    }

    /* ── Reduced motion ── */
    @media (prefers-reduced-motion: reduce) {
      .${CLS.fadeIn} {
        animation: none;
      }
      .${CLS.shimmer}::after {
        animation: none;
      }
      .${CLS.pulseRing} {
        animation: none;
      }
      .${CLS.tagPill}:hover {
        transform: none;
      }
    }
  `;
  document.head.appendChild(style);
}

// ── Main RenderNode component ─────────────────────────────

function RenderNodeRenderer({
  node,
  onUpdateData,
  socketSubscribe,
  socketSend,
  onResize,
}: NodeRenderProps) {
  const data = node.data as RenderNodeData;
  const dataRef = useRef(data);
  dataRef.current = data;

  // Build the dispatcher context once per render so interactive children
  // (e.g. `form`) can post user input back to the paired Leader session.
  // The `submit_form` command is dispatched server-side in
  // `server/commands/submit-form.ts`.
  const renderViewContext = useCallback(
    (): RenderViewContext => ({
      onSubmitForm: (componentId, answers) => {
        const sessionKey = dataRef.current.leaderSessionKey;
        if (!sessionKey || !socketSend) return;
        socketSend({
          type: "submit_form",
          sessionKey,
          formComponentId: componentId,
          formAnswers: answers,
        });
      },
    }),
    [socketSend],
  );

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
        />
      )}

      {/* Header */}
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
            width={20}
            height={20}
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
          <span style={{
            fontSize: 9,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            opacity: 0.7,
          }}>
            {components.length} component{components.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Content area — scroll-capture zone so mouse wheel and trackpad
          two-finger scroll over the dashboard scroll its content instead of
          zooming/panning the canvas. The Canvas wheel handler checks for
          `data-scroll-capture` on the event target's ancestors. */}
      <div
        className={hasContent ? CLS.scrollArea : undefined}
        data-scroll-capture
        style={{
          flex: 1,
          overflow: "auto",
          padding: hasContent ? gap : 0,
          // Prevent scroll chaining: when the dashboard reaches its scroll
          // boundary, don't let the scroll propagate to the canvas/page.
          overscrollBehavior: "contain",
        }}
      >
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
            <div style={{
              fontSize: 12,
              textAlign: "center",
              lineHeight: 1.6,
            }}>
              Waiting for dashboard data...
              <br />
              <span style={{ fontSize: 10, opacity: 0.6 }}>
                The Leader agent will populate this panel
              </span>
            </div>
          </div>
        ) : (
          <div
            className="rd-grid-container"
            style={{
              // Container query lets the grid step down to fewer columns
              // when the node is resized narrow, independent of the
              // agent-declared `columns` (which is treated as a maximum).
              containerType: "inline-size",
              // Expose the declared max column count to the CSS via a
              // custom property so the @container rules can clamp it.
              ["--rd-max-cols" as string]: String(columns),
              ["--rd-gap" as string]: `${gap}px`,
            }}
          >
            <div
              className="rd-grid"
              style={{
                display: "grid",
                // `minmax(0, 1fr)` prevents overflow when a child has
                // intrinsic min-content wider than its track.
                gridTemplateColumns: `repeat(var(--rd-cols, ${columns}), minmax(0, 1fr))`,
                gap,
                // `start` on both axes + `min-content` rows stops short
                // components from being stretched to match a tall sibling.
                alignContent: "start",
                alignItems: "start",
                gridAutoRows: "min-content",
                // Dense packing backfills holes created by full-width
                // items or size-mismatched rows.
                gridAutoFlow: "dense",
              }}
            >
              {components.map((c) => {
                const col = gridColumnFor(c, columns);
                return (
                  <div
                    key={c.id}
                    style={{
                      gridColumn: col,
                      minWidth: 0,
                    }}
                  >
                    <RenderComponentView
                      component={c}
                      context={renderViewContext()}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Graph contract ────────────────────────────────────────
//
// Render nodes expose a `context-out` port so the dashboard a Leader
// has built up can be wired into another Leader as context. The node
// is still not user-creatable from the palette — it's auto-spawned
// alongside its paired Leader — but once it exists on the canvas it
// can act as any other context provider.

const RENDER_CONTRACT: NodeInterfaceContract = {
  nodeType: "render",
  label: "Dashboard",
  description:
    "Live agent-driven dashboard. Connect its context-out port to a " +
    "Leader's context-in port to feed the rendered components into the " +
    "next session as text.",
  ports: [CONTEXT_OUT_PORT],
};

registerContract(RENDER_CONTRACT);

// ── Register ──────────────────────────────────────────────

registerNodeType({
  type: "render",
  label: "Dashboard",
  defaultSize: { width: 460, height: 500 },
  render: RenderNodeRenderer,
  userCreatable: false,  // Only auto-spawned with Leaders
  providesContext: true,
  extractContent: (data) => {
    const renderState = (data as RenderNodeData | undefined)?.renderState;
    if (!renderState) return null;
    const text = flattenRenderStateToText(renderState);
    return text.length > 0 ? text : null;
  },
});
