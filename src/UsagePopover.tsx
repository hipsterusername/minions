/**
 * Inline usage breakdown rendered at the bottom of the expanded sessions panel.
 *
 * Shows cumulative cost, total tokens, cache read share, and a per-model
 * breakdown with a proportional cost bar. The data is computed by
 * `usage-aggregator` and passed in by `SessionPanel`, which keeps a Map of
 * per-session usage updated from incoming SDK results.
 */
import {
  aggregateGlobalUsage,
  formatTokens,
  shortModelLabel,
  type SessionUsage,
} from "./usage-aggregator.ts";

const MODEL_COLORS: Record<string, string> = {
  opus: "var(--model-opus)",
  "opus-4": "var(--model-opus)",
  "opus-4-1": "var(--model-opus)",
  sonnet: "var(--model-sonnet)",
  "sonnet-4": "var(--model-sonnet)",
  "sonnet-4-5": "var(--model-sonnet)",
  haiku: "var(--model-haiku)",
  "haiku-4": "var(--model-haiku)",
  "haiku-4-5": "var(--model-haiku)",
};

function modelColor(short: string): string {
  return MODEL_COLORS[short] ?? "var(--accent, #888)";
}

interface UsageSectionProps {
  sessions: ReadonlyMap<string, SessionUsage>;
}

export function UsageSection({ sessions }: UsageSectionProps) {
  const usage = aggregateGlobalUsage(sessions);
  const hasData = usage.byModel.length > 0;

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
        <UsageStat label="Turns" value={String(turnCount(sessions))} />
        <UsageStat label="Input" value={formatTokens(usage.totalInputTokens)} />
        <UsageStat
          label="Output"
          value={formatTokens(usage.totalOutputTokens)}
        />
        <UsageStat
          label="Cache read"
          value={formatTokens(usage.totalCacheReadTokens)}
        />
        <UsageStat
          label="Cache create"
          value={formatTokens(usage.totalCacheCreationTokens)}
        />
      </div>

      {!hasData && (
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

      {hasData && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div
            style={{
              fontSize: 9,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            By model
          </div>
          {usage.byModel.map(({ model, usage: u }) => {
            const short = shortModelLabel(model);
            const pct =
              usage.totalCost > 0 ? (u.costUSD / usage.totalCost) * 100 : 0;
            const color = modelColor(short);
            return (
              <div
                key={model}
                data-testid={`usage-row-${short}`}
                style={{ display: "flex", flexDirection: "column", gap: 2 }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 10,
                  }}
                >
                  <span style={{ color }}>{short}</span>
                  <span style={{ color: "var(--text-muted)" }}>
                    ${u.costUSD.toFixed(4)} · in {formatTokens(u.inputTokens)}{" "}
                    · out {formatTokens(u.outputTokens)}
                  </span>
                </div>
                <div
                  style={{
                    height: 4,
                    background: "var(--bg-elevated)",
                    borderRadius: 2,
                    overflow: "hidden",
                  }}
                >
                  <div
                    data-testid={`usage-bar-${short}`}
                    style={{
                      width: `${Math.max(pct, 2)}%`,
                      height: "100%",
                      background: color,
                      opacity: 0.75,
                      borderRadius: 2,
                      transition: "width 0.25s",
                    }}
                  />
                </div>
                {u.cacheReadInputTokens > 0 && (
                  <span
                    style={{
                      fontSize: 9,
                      color: "var(--text-muted)",
                      opacity: 0.7,
                    }}
                  >
                    cache read {formatTokens(u.cacheReadInputTokens)} · cache
                    create {formatTokens(u.cacheCreationInputTokens)}
                  </span>
                )}
              </div>
            );
          })}
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

function turnCount(sessions: ReadonlyMap<string, SessionUsage>): number {
  let n = 0;
  for (const s of sessions.values()) n += s.turns;
  return n;
}
