/**
 * Inline usage breakdown rendered at the bottom of the expanded sessions panel.
 *
 * Shows cumulative cost and session count. Data is computed by
 * `usage-aggregator` and passed in by `SessionPanel`, which keeps a Map of
 * per-session usage updated from incoming NormalizedEvent usage/done events.
 */
import {
  aggregateGlobalUsage,
  formatCacheHitRate,
  formatTokens,
  type SessionUsage,
} from "./usage-aggregator.ts";

interface UsageSectionProps {
  sessions: ReadonlyMap<string, SessionUsage>;
}

export function UsageSection({ sessions }: UsageSectionProps) {
  const usage = aggregateGlobalUsage(sessions);

  return (
    <div
      data-testid="usage-section"
      style={{
        padding: "11px 14px 13px",
        fontFamily: "var(--font-mono)",
        color: "var(--text-primary)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 9,
        }}
      >
        <span
          style={{
            fontSize: 10,
            color: "var(--text-muted)",
            textTransform: "uppercase",
            letterSpacing: 0.5,
            fontWeight: 500,
          }}
        >
          Session usage
        </span>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
          {usage.sessionCount} session{usage.sessionCount === 1 ? "" : "s"}
        </span>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: 5,
          fontSize: 10,
        }}
      >
        <UsageStat label="Cost" value={`$${usage.totalCost.toFixed(4)}`} />
        <UsageStat label="Turns" value={String(usage.totalTurns)} />
        <UsageStat label="Input" value={formatTokens(usage.input)} />
        <UsageStat label="Output" value={formatTokens(usage.output)} />
      </div>

      {usage.cacheRead > 0 && (
        <div
          style={{
            marginTop: 7,
            fontSize: 10,
            color: "var(--text-muted)",
            textAlign: "right",
          }}
        >
          Cache hit {formatCacheHitRate(usage.cacheHitRate)}
        </div>
      )}
    </div>
  );
}

function UsageStat({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        minWidth: 0,
        padding: "6px",
        border: "1px solid var(--border-default)",
        borderRadius: 5,
        background: "var(--bg-primary)",
      }}
    >
      <span
        style={{
          display: "block",
          marginBottom: 3,
          color: "var(--text-muted)",
          fontSize: 9,
        }}
      >
        {label}
      </span>
      <span
        style={{
          display: "block",
          overflow: "hidden",
          color: "var(--text-primary)",
          fontVariantNumeric: "tabular-nums",
          textOverflow: "ellipsis",
        }}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
