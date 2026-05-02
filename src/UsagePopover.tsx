/**
 * Inline usage breakdown rendered at the bottom of the expanded sessions panel.
 *
 * Shows cumulative cost and session count. Data is computed by
 * `usage-aggregator` and passed in by `SessionPanel`, which keeps a Map of
 * per-session usage updated from incoming NormalizedEvent usage/done events.
 */
import {
  aggregateGlobalUsage,
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
        padding: "10px 12px",
        fontFamily: "var(--font-mono)",
        color: "var(--text-primary)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 8,
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: "var(--text-secondary)",
            textTransform: "uppercase",
            letterSpacing: 1,
            fontWeight: 600,
          }}
        >
          Usage
        </span>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
          {usage.sessionCount} session{usage.sessionCount === 1 ? "" : "s"}
        </span>
      </div>

      {/* Top-line totals */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 4,
          marginBottom: 10,
          fontSize: 11,
        }}
      >
        <UsageStat label="Cost" value={`$${usage.totalCost.toFixed(4)}`} />
        <UsageStat label="Turns" value={String(usage.totalTurns)} />
      </div>

      {usage.sessionCount === 0 && (
        <div
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            textAlign: "center",
            padding: "10px 0",
            fontStyle: "italic",
          }}
        >
          No usage recorded yet. Send a message to a session to start tracking.
        </div>
      )}
    </div>
  );
}

function UsageStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <span style={{ color: "var(--text-primary)" }}>{value}</span>
    </div>
  );
}
