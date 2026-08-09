/**
 * Render primitives — the agent-driven dashboard component library.
 *
 * Shared source for dashboard
 * component renderers (`RenderComponentView`), grid helpers (`gridColumnFor`,
 * `isFullWidth`), selection UI, and injected styles that the surface consumes.
 */

import { useCallback, useEffect, useInsertionEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import {
  Check,
  X as XIcon,
  AlertTriangle,
  Circle,
  Dot,
  Info,
  ArrowUp,
  ArrowDown,
  ArrowRight,
  type LucideIcon,
} from "lucide-react";
import { SimpleMarkdown } from "../components/SimpleMarkdown.tsx";
import type {
  RenderComponent,
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
  HtmlArtifactComponent,
} from "../../shared/render-dsl.ts";
import { FormComponent } from "./render/FormComponent.tsx";
import { ChartComponent } from "./render/ChartComponent.tsx";
import {
  SectionRenderer,
  TabsRenderer,
} from "./render/ContainerComponents.tsx";
import {
  ImageRenderer,
  FilePreviewRenderer,
  HtmlArtifactRenderer,
} from "./render/ArtifactComponents.tsx";
import { browserLogger } from "../logging.ts";

const log = browserLogger.child("render-node");

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
const STATUS_CONFIG: { [K in StatusKey]: { color: string; Icon: LucideIcon; bg: string } } = {
  success: { color: "var(--status-success)", Icon: Check, bg: "var(--success-bg)" },
  error: { color: "var(--status-error)", Icon: XIcon, bg: "var(--error-bg)" },
  warning: { color: "var(--status-warning)", Icon: AlertTriangle, bg: "var(--warning-bg)" },
  running: { color: "var(--info-color)", Icon: Circle, bg: "var(--info-bg)" },
  pending: { color: "var(--text-muted)", Icon: Dot, bg: "var(--muted-bg)" },
};

type TrendKey = "up" | "down" | "flat";
const TREND_ARROWS: { [K in TrendKey]: { Icon: LucideIcon; color: string } } = {
  up: { Icon: ArrowUp, color: "var(--status-success)" },
  down: { Icon: ArrowDown, color: "var(--status-error)" },
  flat: { Icon: ArrowRight, color: "var(--text-muted)" },
};

// ── Shared CSS class names (injected via injectStyles) ────

export const CLS = {
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
  /** Outer "eye" socket that wraps the moving pupil (running state). */
  eye: "rd-eye",
  /** Inner pupil that performs the saccade animation. */
  pupil: "rd-pupil",
  /** One of four scripted look-around variants assigned per instance. */
  pupilA: "rd-pupil--a",
  pupilB: "rd-pupil--b",
  pupilC: "rd-pupil--c",
  pupilD: "rd-pupil--d",
} as const;

/**
 * Pick one of four eye-saccade variants from a stable string seed.
 *
 * Used so multiple running indicators on the same dashboard pick visually
 * different look-around scripts instead of marching in lockstep.
 */
const PUPIL_VARIANTS = [CLS.pupilA, CLS.pupilB, CLS.pupilC, CLS.pupilD] as const;
function pupilVariantFor(seed: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return PUPIL_VARIANTS[h % PUPIL_VARIANTS.length] ?? CLS.pupilA;
}

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
            color: trend.color,
            lineHeight: 1,
            display: "inline-flex",
            alignItems: "center",
          }}>
            <trend.Icon size={16} strokeWidth={2.5} aria-hidden />
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
              : `linear-gradient(90deg, ${color}, color-mix(in srgb, ${color} 75%, var(--bg-surface)))`,
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
        <span
          className={isRunning ? CLS.eye : undefined}
          style={{
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
            position: "relative",
            overflow: "hidden",
          }}
        >
          {isRunning ? (
            <span
              data-testid="rd-status-pupil"
              className={`${CLS.pupil} ${pupilVariantFor(c.id)}`}
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: cfg.color,
                boxShadow: `0 0 6px color-mix(in srgb, ${cfg.color} 60%, transparent)`,
                ["--rd-pupil-amp" as string]: 4,
              }}
            />
          ) : (
            <cfg.Icon size={12} strokeWidth={3} aria-hidden />
          )}
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

          {variant !== "bar" && points.length > 1 && (
            <>
              <circle cx={points[0]!.x} cy={points[0]!.y} r="2" fill={color} opacity={0.5} />
              <circle cx={points[points.length - 1]!.x} cy={points[points.length - 1]!.y} r="2.5" fill={color} />
            </>
          )}
        </svg>

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
              <div style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                width: 16,
                flexShrink: 0,
              }}>
                <div
                  className={isRunning ? CLS.eye : undefined}
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: `color-mix(in srgb, ${cfg.color} 20%, transparent)`,
                    border: `2px solid ${cfg.color}`,
                    flexShrink: 0,
                    marginTop: 3,
                    boxSizing: "border-box",
                    position: "relative",
                    overflow: "hidden",
                    display: isRunning ? "flex" : undefined,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {isRunning && (
                    <span
                      data-testid="rd-timeline-pupil"
                      className={`${CLS.pupil} ${pupilVariantFor(`tl-${i}`)}`}
                      style={{
                        width: 3,
                        height: 3,
                        borderRadius: "50%",
                        background: cfg.color,
                        boxShadow: `0 0 4px color-mix(in srgb, ${cfg.color} 70%, transparent)`,
                        ["--rd-pupil-amp" as string]: 1.6,
                      }}
                    />
                  )}
                </div>
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
const CALLOUT_CONFIG: { [K in CalloutVariant]: { color: string; bg: string; Icon: LucideIcon } } = {
  info: { color: "var(--info-color)", bg: "var(--info-bg)", Icon: Info },
  warning: { color: "var(--status-warning)", bg: "var(--warning-bg)", Icon: AlertTriangle },
  success: { color: "var(--status-success)", bg: "var(--success-bg)", Icon: Check },
  error: { color: "var(--status-error)", bg: "var(--error-bg)", Icon: XIcon },
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
        <cfg.Icon size={13} strokeWidth={2.75} aria-hidden />
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
      log.warn("copy_failed", { error: err });
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
  /** Dashboard-level expand/collapse state for all section components. */
  sectionExpansionState?: boolean | undefined;
}

export function RenderComponentView({
  component,
  context,
}: {
  component: RenderComponent;
  context?: RenderViewContext | undefined;
}) {
  // The dashboard can be hosted by both the canvas and mobile surfaces. Keep
  // its CSS lifecycle with the rendered primitives so a new host cannot omit
  // the saccade keyframes (and useInsertionEffect puts them in place before
  // the browser paints an animated pupil for the first time).
  useRenderStyles();

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
          globalOpenState={context?.sectionExpansionState}
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
    case "html-artifact":
      return <HtmlArtifactRenderer c={component as HtmlArtifactComponent} />;
    default:
      return null;
  }
}

export function hasSectionComponent(components: readonly RenderComponent[]): boolean {
  for (const component of components) {
    if (component.type === "section") return true;
    if (component.type === "tabs") {
      if (component.tabs.some((tab) => hasSectionComponent(tab.components))) return true;
    }
  }
  return false;
}

type DashboardSelectionIconKind =
  | "copy"
  | "copy-full"
  | "node"
  | "select-all"
  | "clear"
  | "exit";

function DashboardSelectionIcon({ kind }: { kind: DashboardSelectionIconKind }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  switch (kind) {
    case "copy":
      return (
        <svg {...common}>
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      );
    case "copy-full":
      return (
        <svg {...common}>
          <rect x="4" y="3" width="14" height="18" rx="2" />
          <path d="M8 7h6" />
          <path d="M8 11h6" />
          <path d="M8 15h4" />
          <path d="M18 8h2v13a2 2 0 0 1-2 2h-9v-2" />
        </svg>
      );
    case "node":
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M12 18v-6" />
          <path d="M9 15h6" />
        </svg>
      );
    case "select-all":
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="m8 12 3 3 5-6" />
        </svg>
      );
    case "clear":
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M9 9l6 6" />
          <path d="M15 9l-6 6" />
        </svg>
      );
    case "exit":
      return (
        <svg {...common}>
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      );
  }
}

export function DashboardSelectionGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      aria-label={label}
      role="group"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        paddingInlineStart: 5,
        borderLeft: "1px solid var(--border-default)",
      }}
    >
      {children}
    </div>
  );
}

export function DashboardSelectionButton({
  icon,
  label,
  onClick,
  disabled = false,
  tone = "neutral",
}: {
  icon: DashboardSelectionIconKind;
  label: string;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  tone?: "neutral" | "primary";
}) {
  const isPrimary = tone === "primary";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      style={{
        width: 26,
        height: 26,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        borderRadius: 4,
        border: `1px solid ${
          disabled
            ? "var(--border-default)"
            : isPrimary
              ? "color-mix(in srgb, var(--accent) 54%, var(--border-default))"
              : "var(--border-default)"
        }`,
        background: disabled
          ? "var(--bg-primary)"
          : isPrimary
            ? "color-mix(in srgb, var(--accent) 14%, var(--bg-elevated))"
            : "var(--bg-elevated)",
        color: disabled
          ? "var(--text-dim)"
          : isPrimary
            ? "var(--accent)"
            : "var(--text-secondary)",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      <DashboardSelectionIcon kind={icon} />
    </button>
  );
}

function isDashboardInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      "button,input,textarea,select,a,[role='tab'],[data-dashboard-context-action]",
    ),
  );
}

export function SelectableDashboardComponent({
  componentId,
  selectionActive,
  selected,
  onToggle,
  children,
}: {
  componentId: string;
  selectionActive: boolean;
  selected: boolean;
  onToggle: (componentId: string) => void;
  children: ReactNode;
}) {
  const toggle = useCallback(() => onToggle(componentId), [componentId, onToggle]);
  const label = selected
    ? "Remove component from context selection"
    : "Add component to context selection";

  return (
    <div
      className={`render-context-selectable${
        selectionActive ? " render-context-selectable--active" : ""
      }${selected ? " render-context-selectable--selected" : ""}`}
      data-testid="render-context-component"
      data-component-id={componentId}
      data-selected={selected ? "true" : undefined}
      role={selectionActive ? "checkbox" : undefined}
      aria-checked={selectionActive ? selected : undefined}
      tabIndex={selectionActive ? 0 : undefined}
      onClick={(e) => {
        if (!selectionActive || isDashboardInteractiveTarget(e.target)) return;
        e.stopPropagation();
        toggle();
      }}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if (!selectionActive) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      }}
    >
      <button
        type="button"
        className="render-context-selectable__marker"
        data-dashboard-context-action
        title={label}
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
      >
        {selected ? "✓" : "+"}
      </button>
      {children}
    </div>
  );
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
  "html-artifact",
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

export const RENDER_STYLE_ELEMENT_ID = "render-node-styles";

function useRenderStyles() {
  useInsertionEffect(() => {
    injectStyles();
  }, []);
}

export function injectStyles() {
  if (
    typeof document === "undefined" ||
    document.getElementById(RENDER_STYLE_ELEMENT_ID)
  ) {
    return;
  }
  const style = document.createElement("style");
  style.id = RENDER_STYLE_ELEMENT_ID;
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

    /* ── Eye/pupil saccade microinteractions ─────────────────
       Hand-scripted timeline that mimics anime.js: per-keyframe
       cubic-bezier easings make the "saccade" segments feel snappy
       (easeOutExpo) while held fixation points stay still. Each
       cycle visits three points in region A, jumps to region B,
       and visits three more — short/long/medium dwell — so the
       indicator looks like it's *looking at things* and pausing,
       not just pulsing. Four variants ship so multiple running
       indicators on one dashboard never march in lockstep.

       Translation magnitude is parameterized via --rd-pupil-amp so
       the same keyframes drive the 20px status badge (amp ≈ 4) and
       the 10px timeline dot (amp ≈ 1.6).
       ───────────────────────────────────────────────────────── */
    .${CLS.eye} {
      position: relative;
    }
    .${CLS.pupil} {
      will-change: transform;
      transform: translate(0, 0);
    }

    /* Variant A — upper-left → lower-right diagonal sweep */
    .${CLS.pupilA} {
      animation: render-eye-a 6.4s infinite both;
    }
    @keyframes render-eye-a {
      0%   { transform: translate(calc(var(--rd-pupil-amp,3) * -0.7px), calc(var(--rd-pupil-amp,3) * -0.6px)); }
      12%  { transform: translate(calc(var(--rd-pupil-amp,3) * -0.7px), calc(var(--rd-pupil-amp,3) * -0.6px));
             animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
      15%  { transform: translate(calc(var(--rd-pupil-amp,3) * -0.4px), calc(var(--rd-pupil-amp,3) * -0.85px)); }
      36%  { transform: translate(calc(var(--rd-pupil-amp,3) * -0.4px), calc(var(--rd-pupil-amp,3) * -0.85px));
             animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
      39%  { transform: translate(calc(var(--rd-pupil-amp,3) *  0.2px), calc(var(--rd-pupil-amp,3) * -0.5px)); }
      53%  { transform: translate(calc(var(--rd-pupil-amp,3) *  0.2px), calc(var(--rd-pupil-amp,3) * -0.5px));
             animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
      57%  { transform: translate(calc(var(--rd-pupil-amp,3) *  0.6px), calc(var(--rd-pupil-amp,3) *  0.7px)); }
      65%  { transform: translate(calc(var(--rd-pupil-amp,3) *  0.6px), calc(var(--rd-pupil-amp,3) *  0.7px));
             animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
      68%  { transform: translate(calc(var(--rd-pupil-amp,3) *  0.85px), calc(var(--rd-pupil-amp,3) *  0.35px)); }
      87%  { transform: translate(calc(var(--rd-pupil-amp,3) *  0.85px), calc(var(--rd-pupil-amp,3) *  0.35px));
             animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
      90%  { transform: translate(calc(var(--rd-pupil-amp,3) *  0.3px), calc(var(--rd-pupil-amp,3) *  0.65px)); }
      97%  { transform: translate(calc(var(--rd-pupil-amp,3) *  0.3px), calc(var(--rd-pupil-amp,3) *  0.65px));
             animation-timing-function: cubic-bezier(0.45, 0, 0.55, 1); }
      100% { transform: translate(calc(var(--rd-pupil-amp,3) * -0.7px), calc(var(--rd-pupil-amp,3) * -0.6px)); }
    }

    /* Variant B — upper-right → lower-left, slightly slower */
    .${CLS.pupilB} {
      animation: render-eye-b 7.1s infinite both;
    }
    @keyframes render-eye-b {
      0%   { transform: translate(calc(var(--rd-pupil-amp,3) *  0.8px), calc(var(--rd-pupil-amp,3) * -0.5px)); }
      10%  { transform: translate(calc(var(--rd-pupil-amp,3) *  0.8px), calc(var(--rd-pupil-amp,3) * -0.5px));
             animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
      13%  { transform: translate(calc(var(--rd-pupil-amp,3) *  0.55px), calc(var(--rd-pupil-amp,3) * -0.85px)); }
      37%  { transform: translate(calc(var(--rd-pupil-amp,3) *  0.55px), calc(var(--rd-pupil-amp,3) * -0.85px));
             animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
      40%  { transform: translate(calc(var(--rd-pupil-amp,3) *  0.1px), calc(var(--rd-pupil-amp,3) * -0.4px)); }
      52%  { transform: translate(calc(var(--rd-pupil-amp,3) *  0.1px), calc(var(--rd-pupil-amp,3) * -0.4px));
             animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
      56%  { transform: translate(calc(var(--rd-pupil-amp,3) * -0.7px), calc(var(--rd-pupil-amp,3) *  0.55px)); }
      64%  { transform: translate(calc(var(--rd-pupil-amp,3) * -0.7px), calc(var(--rd-pupil-amp,3) *  0.55px));
             animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
      67%  { transform: translate(calc(var(--rd-pupil-amp,3) * -0.85px), calc(var(--rd-pupil-amp,3) *  0.85px)); }
      88%  { transform: translate(calc(var(--rd-pupil-amp,3) * -0.85px), calc(var(--rd-pupil-amp,3) *  0.85px));
             animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
      91%  { transform: translate(calc(var(--rd-pupil-amp,3) * -0.4px), calc(var(--rd-pupil-amp,3) *  0.5px)); }
      98%  { transform: translate(calc(var(--rd-pupil-amp,3) * -0.4px), calc(var(--rd-pupil-amp,3) *  0.5px));
             animation-timing-function: cubic-bezier(0.45, 0, 0.55, 1); }
      100% { transform: translate(calc(var(--rd-pupil-amp,3) *  0.8px), calc(var(--rd-pupil-amp,3) * -0.5px)); }
    }

    /* Variant C — vertical top↔bottom scan with horizontal drift */
    .${CLS.pupilC} {
      animation: render-eye-c 6.8s infinite both;
    }
    @keyframes render-eye-c {
      0%   { transform: translate(calc(var(--rd-pupil-amp,3) *  0.0px), calc(var(--rd-pupil-amp,3) * -0.85px)); }
      11%  { transform: translate(calc(var(--rd-pupil-amp,3) *  0.0px), calc(var(--rd-pupil-amp,3) * -0.85px));
             animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
      14%  { transform: translate(calc(var(--rd-pupil-amp,3) *  0.4px), calc(var(--rd-pupil-amp,3) * -0.65px)); }
      35%  { transform: translate(calc(var(--rd-pupil-amp,3) *  0.4px), calc(var(--rd-pupil-amp,3) * -0.65px));
             animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
      38%  { transform: translate(calc(var(--rd-pupil-amp,3) * -0.45px), calc(var(--rd-pupil-amp,3) * -0.55px)); }
      51%  { transform: translate(calc(var(--rd-pupil-amp,3) * -0.45px), calc(var(--rd-pupil-amp,3) * -0.55px));
             animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
      55%  { transform: translate(calc(var(--rd-pupil-amp,3) * -0.1px), calc(var(--rd-pupil-amp,3) *  0.85px)); }
      63%  { transform: translate(calc(var(--rd-pupil-amp,3) * -0.1px), calc(var(--rd-pupil-amp,3) *  0.85px));
             animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
      66%  { transform: translate(calc(var(--rd-pupil-amp,3) *  0.5px), calc(var(--rd-pupil-amp,3) *  0.6px)); }
      86%  { transform: translate(calc(var(--rd-pupil-amp,3) *  0.5px), calc(var(--rd-pupil-amp,3) *  0.6px));
             animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
      89%  { transform: translate(calc(var(--rd-pupil-amp,3) * -0.55px), calc(var(--rd-pupil-amp,3) *  0.45px)); }
      97%  { transform: translate(calc(var(--rd-pupil-amp,3) * -0.55px), calc(var(--rd-pupil-amp,3) *  0.45px));
             animation-timing-function: cubic-bezier(0.45, 0, 0.55, 1); }
      100% { transform: translate(calc(var(--rd-pupil-amp,3) *  0.0px), calc(var(--rd-pupil-amp,3) * -0.85px)); }
    }

    /* Variant D — scattered, longest cycle */
    .${CLS.pupilD} {
      animation: render-eye-d 7.6s infinite both;
    }
    @keyframes render-eye-d {
      0%   { transform: translate(calc(var(--rd-pupil-amp,3) * -0.6px), calc(var(--rd-pupil-amp,3) *  0.7px)); }
      9%   { transform: translate(calc(var(--rd-pupil-amp,3) * -0.6px), calc(var(--rd-pupil-amp,3) *  0.7px));
             animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
      12%  { transform: translate(calc(var(--rd-pupil-amp,3) * -0.85px), calc(var(--rd-pupil-amp,3) *  0.2px)); }
      34%  { transform: translate(calc(var(--rd-pupil-amp,3) * -0.85px), calc(var(--rd-pupil-amp,3) *  0.2px));
             animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
      37%  { transform: translate(calc(var(--rd-pupil-amp,3) * -0.3px), calc(var(--rd-pupil-amp,3) *  0.45px)); }
      50%  { transform: translate(calc(var(--rd-pupil-amp,3) * -0.3px), calc(var(--rd-pupil-amp,3) *  0.45px));
             animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
      54%  { transform: translate(calc(var(--rd-pupil-amp,3) *  0.7px), calc(var(--rd-pupil-amp,3) * -0.7px)); }
      62%  { transform: translate(calc(var(--rd-pupil-amp,3) *  0.7px), calc(var(--rd-pupil-amp,3) * -0.7px));
             animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
      65%  { transform: translate(calc(var(--rd-pupil-amp,3) *  0.4px), calc(var(--rd-pupil-amp,3) * -0.85px)); }
      85%  { transform: translate(calc(var(--rd-pupil-amp,3) *  0.4px), calc(var(--rd-pupil-amp,3) * -0.85px));
             animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
      88%  { transform: translate(calc(var(--rd-pupil-amp,3) *  0.85px), calc(var(--rd-pupil-amp,3) * -0.3px)); }
      97%  { transform: translate(calc(var(--rd-pupil-amp,3) *  0.85px), calc(var(--rd-pupil-amp,3) * -0.3px));
             animation-timing-function: cubic-bezier(0.45, 0, 0.55, 1); }
      100% { transform: translate(calc(var(--rd-pupil-amp,3) * -0.6px), calc(var(--rd-pupil-amp,3) *  0.7px)); }
    }

    /* ── Shimmer for active progress bars ── */
    .${CLS.shimmer}::after {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(
        90deg,
        transparent,
        color-mix(in srgb, var(--text-primary) 12%, transparent),
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
      .${CLS.pupil} {
        animation: none;
        transform: none;
      }
    }
  `;
  document.head.appendChild(style);
}
