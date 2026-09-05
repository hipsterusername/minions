import { useMemo } from "react";
import { TaskPlanPanel } from "../TaskPlanPanel.tsx";
import type { LeaderData, TaskPlanItem } from "../types.ts";

/**
 * Left "Activity Rail" of the Leader fullscreen cockpit.
 *
 * Stacks the always-expanded Task Plan on top of a Minion roster
 * derived from `taskPlan[]` (each minion-executor task contributes one
 * row, deduplicated by sessionKey). Clicking a minion fires the same
 * `onRevealMinion` callback the in-canvas TaskPlanPanel uses so the
 * canvas pans to that minion node.
 */

interface MinionRow {
  sessionKey: string;
  title: string;
  status: TaskPlanItem["status"];
  activeStep: string | null;
  cost: number;
  completedAt: number | null;
}

function deriveMinionRoster(taskPlan: TaskPlanItem[]): MinionRow[] {
  const rows: MinionRow[] = [];
  const seen = new Set<string>();
  for (const task of taskPlan) {
    if (task.executor !== "minion") continue;
    const key = task.minionSessionKey ?? task.taskId;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      sessionKey: key,
      title: task.title,
      status: task.status,
      activeStep: task.activeStep ?? null,
      cost: task.cost,
      completedAt: task.completedAt,
    });
  }
  return rows;
}

const STATUS_DOT_COLOR: Record<TaskPlanItem["status"], string> = {
  planned: "var(--text-muted)",
  starting: "var(--status-creating)",
  running: "var(--status-creating)",
  blocked: "var(--warning-color)",
  completed: "var(--success-color)",
  failed: "var(--danger-color)",
  ended_without_report: "var(--warning-color)",
  cancelled: "var(--text-muted)",
  orphaned: "var(--danger-color)",
};

export function ActivityRail({
  data,
  onRevealMinion,
}: {
  data: LeaderData;
  onRevealMinion?: ((minionSessionKey: string) => void) | undefined;
}) {
  const minions = useMemo(
    () => deriveMinionRoster(data.taskPlan ?? []),
    [data.taskPlan],
  );

  return (
    <aside
      data-testid="leader-fullscreen-activity-rail"
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-surface)",
        minWidth: 0,
        overflow: "hidden",
        height: "100%",
      }}
    >
      <div
        data-scroll-capture
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <TaskPlanPanel
          taskPlan={data.taskPlan ?? []}
          expanded
          onToggle={() => {
            /* Always expanded in fullscreen */
          }}
          onRevealMinion={onRevealMinion}
        />

        <section
          data-testid="leader-fullscreen-minion-roster"
          style={{
            flexShrink: 0,
            borderTop: "1px solid var(--border-default)",
            padding: "8px 12px",
          }}
        >
          <header
            style={{
              fontSize: 9,
              fontFamily: "var(--font-mono)",
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: 0.6,
              fontWeight: 600,
              marginBottom: 6,
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>Minions</span>
            <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>
              {minions.length}
            </span>
          </header>
          {minions.length === 0 ? (
            <div
              style={{
                fontSize: 10,
                color: "var(--text-muted)",
                fontStyle: "italic",
                fontFamily: "var(--font-mono)",
                padding: "8px 0",
              }}
            >
              Delegated work appears here. Your leader can also work directly.
            </div>
          ) : (
            <ul
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              {minions.map((m) => {
                const canReveal = !!onRevealMinion;
                return (
                  <li key={m.sessionKey}>
                    <button
                      data-testid={`minion-row-${m.sessionKey}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRevealMinion?.(m.sessionKey);
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      disabled={!canReveal}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "5px 6px",
                        background: "transparent",
                        border: "1px solid transparent",
                        borderRadius: 4,
                        color: "var(--text-primary)",
                        fontSize: 11,
                        textAlign: "left",
                        cursor: canReveal ? "pointer" : "default",
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={(e) => {
                        if (canReveal)
                          e.currentTarget.style.background =
                            "var(--bg-elevated)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: "50%",
                          background: STATUS_DOT_COLOR[m.status],
                          flexShrink: 0,
                          boxShadow:
                            m.status === "running"
                              ? "0 0 6px var(--status-creating)"
                              : "none",
                        }}
                      />
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {m.title}
                      </span>
                      <span style={{ fontSize: 10, color: STATUS_DOT_COLOR[m.status] }}>{m.status.replaceAll("_", " ")}</span>
                      {m.cost > 0 && (
                        <span
                          style={{
                            fontSize: 9,
                            color: "var(--text-muted)",
                            fontFamily: "var(--font-mono)",
                            flexShrink: 0,
                          }}
                        >
                          ${m.cost.toFixed(3)}
                        </span>
                      )}
                    </button>
                    {m.status === "running" && m.activeStep && (
                      <div
                        style={{
                          padding: "0 6px 4px 19px",
                          fontSize: 9,
                          color: "var(--text-muted)",
                          fontFamily: "var(--font-mono)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {m.activeStep}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </aside>
  );
}
