import { useEffect, useState, type RefObject } from "react";
import { buildLeaderSystemPrompt } from "../../../prompts/build-leader-prompt.ts";
import { CopyButton } from "../../../components/CopyButton.tsx";
import type { LeaderData } from "../types.ts";
import { selectCanvasChangeMode } from "../work-item.ts";

/**
 * Right-side tabbed context drawer for the Leader fullscreen cockpit.
 *
 * Tabs:
 *   - Overview: status, cost, turns, wait countdown, recent activity stats
 *   - Worktree: branch, isolation flag, status
 *   - Approval: pending approval summary + diff stats (when set)
 *   - Skills: armed skills list (opens the existing flyout for edits)
 *   - Prompt: composed leader system prompt (read-only preview)
 *
 * All tabs are pure presentation fed by `data` — no internal session
 * subscriptions. State changes flow back through `onUpdateData` so the
 * cockpit and the in-canvas card stay in sync via the shared LeaderData
 * source-of-truth.
 */

type TabId = "overview" | "worktree" | "approval" | "skills" | "prompt";

export function ContextDrawer({
  data,
  onUpdateData,
  skillFlyoutAnchorRef,
  onOpenSkillFlyout,
}: {
  data: LeaderData;
  onUpdateData: (next: LeaderData) => void;
  skillFlyoutAnchorRef: RefObject<HTMLElement | null>;
  onOpenSkillFlyout: () => void;
}) {
  const isWorktreeMode = selectCanvasChangeMode(data) === "worktree";
  const approvalPending = isWorktreeMode && !!data.approvalPending;
  const [activeTab, setActiveTab] = useState<TabId>(
    approvalPending ? "approval" : "overview",
  );

  useEffect(() => {
    if (!isWorktreeMode && activeTab === "approval") setActiveTab("overview");
  }, [activeTab, isWorktreeMode]);

  const tabs: { id: TabId; label: string; badge?: string | undefined }[] = [
    { id: "overview", label: "Overview" },
    { id: "worktree", label: "Worktree" },
    ...(isWorktreeMode ? [{
      id: "approval",
      label: "Approval",
      ...(approvalPending ? { badge: "•" } : {}),
    } as const] : []),
    { id: "skills", label: "Skills" },
    { id: "prompt", label: "Prompt" },
  ];

  return (
    <aside
      data-testid="leader-fullscreen-context-drawer"
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-surface)",
        borderLeft: "1px solid var(--border-default)",
        minWidth: 0,
        height: "100%",
      }}
    >
      {/* Tab strip — compact pills with accent underline.
          Horizontal scroll is the safety net when the drawer is narrow:
          tabs always stay on a single row, no wrap, no overflow-clip. */}
      <div
        role="tablist"
        aria-label="Context drawer tabs"
        data-no-drag
        onWheel={(e) => {
          // Convert vertical wheel to horizontal scroll inside the tab
          // strip so a trackpad swipe doesn't also pan the canvas under
          // the overlay. Required because the wheel listener on the
          // outer overlay calls stopPropagation but not preventDefault.
          if (e.deltaY !== 0 && e.currentTarget.scrollWidth > e.currentTarget.clientWidth) {
            e.currentTarget.scrollLeft += e.deltaY;
          }
        }}
        style={{
          display: "flex",
          gap: 2,
          padding: "4px 6px 0",
          borderBottom: "1px solid var(--border-default)",
          flexShrink: 0,
          background: "var(--bg-secondary)",
          overflowX: "auto",
          overflowY: "hidden",
          scrollbarWidth: "thin",
          whiteSpace: "nowrap",
        }}
      >
        {tabs.map((t) => {
          const isActive = activeTab === t.id;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={isActive}
              data-testid={`drawer-tab-${t.id}`}
              onClick={() => setActiveTab(t.id)}
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                padding: "5px 9px",
                background: "transparent",
                border: "none",
                borderBottom: isActive
                  ? "2px solid var(--accent)"
                  : "2px solid transparent",
                color: isActive ? "var(--text-primary)" : "var(--text-muted)",
                fontSize: 10,
                fontWeight: isActive ? 700 : 500,
                fontFamily: "var(--font-mono)",
                cursor: "pointer",
                flexShrink: 0,
                transition: "color 0.15s, border-color 0.15s",
                marginBottom: -1,
                letterSpacing: 0.2,
              }}
              onMouseEnter={(e) => {
                if (!isActive)
                  e.currentTarget.style.color = "var(--text-secondary)";
              }}
              onMouseLeave={(e) => {
                if (!isActive)
                  e.currentTarget.style.color = "var(--text-muted)";
              }}
            >
              {t.label}
              {t.badge && (
                <span
                  style={{
                    marginLeft: 4,
                    color: "var(--accent)",
                    fontWeight: 700,
                  }}
                >
                  {t.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab body */}
      <div
        role="tabpanel"
        data-testid={`drawer-panel-${activeTab}`}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "12px 14px",
          fontSize: 12,
          color: "var(--text-secondary)",
          lineHeight: 1.5,
        }}
      >
        {activeTab === "overview" && <OverviewPanel data={data} />}
        {activeTab === "worktree" && <WorktreePanel data={data} />}
        {activeTab === "approval" && <ApprovalPanel data={data} />}
        {activeTab === "skills" && (
          <SkillsPanel
            data={data}
            onUpdateData={onUpdateData}
            anchorRef={skillFlyoutAnchorRef}
            onOpen={onOpenSkillFlyout}
          />
        )}
        {activeTab === "prompt" && <PromptPanel data={data} />}
      </div>
    </aside>
  );
}

function StatRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "4px 0",
        borderBottom: "1px dashed var(--border-default)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
      }}
    >
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <span style={{ color: "var(--text-primary)", textAlign: "right" }}>
        {value}
      </span>
    </div>
  );
}

function HeroMetric({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string | undefined;
}) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        padding: "10px 12px",
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-default)",
        borderRadius: 6,
      }}
    >
      <div
        style={{
          fontSize: 9,
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          textTransform: "uppercase",
          letterSpacing: 0.5,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: "var(--text-primary)",
          fontFamily: "var(--font-mono)",
          lineHeight: 1.1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </div>
      {hint && (
        <div
          style={{
            marginTop: 2,
            fontSize: 9,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}

function TaskProgressBar({
  done,
  running,
  total,
}: {
  done: number;
  running: number;
  total: number;
}) {
  if (total === 0) return null;
  const donePct = (done / total) * 100;
  const runningPct = (running / total) * 100;
  return (
    <div style={{ marginTop: 6 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 10,
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          marginBottom: 4,
        }}
      >
        <span>Task progress</span>
        <span>
          {done}/{total}
          {running > 0 && (
            <span style={{ color: "var(--status-creating)" }}> · {running}↻</span>
          )}
        </span>
      </div>
      <div
        style={{
          height: 6,
          borderRadius: 3,
          background: "var(--bg-elevated)",
          overflow: "hidden",
          display: "flex",
        }}
      >
        <div
          style={{
            width: `${donePct}%`,
            background: "var(--success-color)",
            transition: "width 0.3s ease",
          }}
        />
        <div
          style={{
            width: `${runningPct}%`,
            background: "var(--status-creating)",
            opacity: 0.6,
            transition: "width 0.3s ease",
            backgroundImage:
              "repeating-linear-gradient(45deg, rgba(255,255,255,0.15) 0 4px, transparent 4px 8px)",
          }}
        />
      </div>
    </div>
  );
}

function OverviewPanel({ data }: { data: LeaderData }) {
  const totalTasks = data.taskPlan?.length ?? 0;
  const doneTasks =
    data.taskPlan?.filter(
      (t) => t.status === "completed" || t.status === "failed",
    ).length ?? 0;
  const runningTasks =
    data.taskPlan?.filter((t) => t.status === "running").length ?? 0;
  const minionTasks =
    data.taskPlan?.filter((t) => t.executor === "minion").length ?? 0;
  const skillCount = data.skillIds?.length ?? 0;
  const avgCostPerTurn = data.turns > 0 ? data.totalCost / data.turns : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Hero metrics row */}
      <div style={{ display: "flex", gap: 6 }}>
        <HeroMetric
          label="Cost"
          value={`$${data.totalCost.toFixed(3)}`}
          hint={
            avgCostPerTurn > 0
              ? `$${avgCostPerTurn.toFixed(4)}/turn`
              : undefined
          }
        />
        <HeroMetric label="Turns" value={data.turns} />
      </div>

      <TaskProgressBar
        done={doneTasks}
        running={runningTasks}
        total={totalTasks}
      />

      {/* Configuration table */}
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        <StatRow label="Status" value={data.status} />
        <StatRow label="Messages" value={data.messages.length} />
        <StatRow label="Minion tasks" value={minionTasks} />
        <StatRow label="Skills armed" value={skillCount} />
        <StatRow label="Model" value={data.model ?? "—"} />
        <StatRow label="Harness" value={data.harness ?? "claude"} />
        <StatRow label="Permission" value={data.permissionMode ?? "auto"} />
      </div>

      {data.waitUntil && data.waitUntil > Date.now() && (
        <div
          style={{
            padding: "8px 10px",
            background: "var(--state-active)",
            border: "1px solid var(--accent)",
            borderRadius: 6,
            fontSize: 11,
          }}
        >
          ⏳ Waiting · {Math.ceil((data.waitUntil - Date.now()) / 1000)}s
          remaining
          {data.waitReason && (
            <div
              style={{
                marginTop: 4,
                color: "var(--text-muted)",
                fontSize: 10,
              }}
            >
              {data.waitReason}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function WorktreePanel({ data }: { data: LeaderData }) {
  if (selectCanvasChangeMode(data) === "live") {
    return (
      <div style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
        Live mode is active. Changes apply directly to the current working tree
        and do not wait for approval.
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <StatRow label="Isolation" value="enabled" />
      <StatRow label="Status" value={data.worktreeStatus} />
      <StatRow label="Branch" value={data.worktreeBranch ?? "—"} />
      {data.worktreePath && (
        <div
          style={{
            marginTop: 8,
            padding: "6px 8px",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-default)",
            borderRadius: 4,
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
            wordBreak: "break-all",
          }}
        >
          {data.worktreePath}
        </div>
      )}
    </div>
  );
}

function ApprovalPanel({ data }: { data: LeaderData }) {
  if (!data.approvalPending) {
    return (
      <div style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
        No pending approval. When the leader calls{" "}
        <code style={{ fontFamily: "var(--font-mono)" }}>request_approval</code>{" "}
        the diff summary will appear here.
      </div>
    );
  }
  const diff = data.approvalDiff;
  return (
    <div>
      {data.approvalSummary && (
        <div
          style={{
            padding: "8px 10px",
            background: "var(--state-active)",
            border: "1px solid var(--accent)",
            borderRadius: 6,
            marginBottom: 10,
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
          }}
        >
          {data.approvalSummary}
        </div>
      )}
      {diff && (
        <>
          <StatRow label="Files changed" value={diff.filesChanged} />
          <StatRow
            label="Insertions"
            value={
              <span style={{ color: "var(--success-color)" }}>
                +{diff.insertions}
              </span>
            }
          />
          <StatRow
            label="Deletions"
            value={
              <span style={{ color: "var(--status-error)" }}>
                -{diff.deletions}
              </span>
            }
          />
          <StatRow label="Commits" value={diff.commits.length} />
          {diff.files.length > 0 && (
            <div
              style={{
                marginTop: 10,
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                padding: "6px 8px",
                maxHeight: 200,
                overflowY: "auto",
              }}
            >
              {diff.files.map((f, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "2px 0",
                  }}
                >
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 600,
                      minWidth: 12,
                      color:
                        f.status === "added"
                          ? "var(--success-color)"
                          : f.status === "deleted"
                            ? "var(--status-error)"
                            : "var(--accent)",
                    }}
                  >
                    {f.status === "added"
                      ? "A"
                      : f.status === "deleted"
                        ? "D"
                        : "M"}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {f.file}
                  </span>
                  <span style={{ color: "var(--success-color)" }}>
                    +{f.insertions}
                  </span>
                  <span style={{ color: "var(--status-error)" }}>
                    -{f.deletions}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <div
        style={{
          marginTop: 10,
          padding: "6px 8px",
          fontSize: 10,
          color: "var(--text-muted)",
          fontStyle: "italic",
        }}
      >
        Use the Approve / Discard controls in the bottom config bar to act on
        this approval.
      </div>
    </div>
  );
}

function SkillsPanel({
  data,
  anchorRef,
  onOpen,
}: {
  data: LeaderData;
  onUpdateData: (next: LeaderData) => void;
  anchorRef: RefObject<HTMLElement | null>;
  onOpen: () => void;
}) {
  const skillIds = data.skillIds ?? [];
  return (
    <div>
      <button
        ref={anchorRef as RefObject<HTMLButtonElement>}
        onClick={onOpen}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          padding: "6px 12px",
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          fontWeight: 600,
          background:
            skillIds.length > 0 ? "var(--state-active)" : "var(--bg-elevated)",
          border:
            skillIds.length > 0
              ? "1px solid var(--accent)"
              : "1px dashed var(--border-default)",
          borderRadius: 4,
          color: skillIds.length > 0 ? "var(--accent)" : "var(--text-muted)",
          cursor: "pointer",
        }}
      >
        ⚡ Manage skills {skillIds.length > 0 ? `(${skillIds.length})` : ""}
      </button>
      {/* Note: The actual SkillFlyout modal is rendered by LeaderNodeRenderer
          and is portaled to document.body, so it appears on top of this
          overlay when `onOpen` is called. We just provide the anchor + trigger
          here. */}
      <div
        style={{
          marginTop: 10,
          fontSize: 11,
          color: "var(--text-muted)",
          lineHeight: 1.5,
        }}
      >
        {skillIds.length === 0
          ? "No skills armed. Add skills to extend the leader with focused playbooks."
          : `${skillIds.length} skill${skillIds.length === 1 ? "" : "s"} armed. The composed instructions appear in the Prompt tab.`}
      </div>
    </div>
  );
}

function PromptPanel({ data }: { data: LeaderData }) {
  let prompt = "";
  try {
    prompt = buildLeaderSystemPrompt({
      skillIds: data.skillIds ?? [],
      skillValues: data.skillValues ?? {},
      systemPromptPrefix: data.systemPromptPrefix ?? null,
    });
  } catch (err) {
    prompt = `# Error building prompt\n${(err as Error)?.message ?? String(err)}`;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span
          style={{
            fontSize: 10,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          Composed system prompt
        </span>
        <CopyButton text={prompt} layout="inline" alwaysVisible />
      </div>
      <pre
        style={{
          margin: 0,
          padding: "10px 12px",
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-default)",
          borderRadius: 4,
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          color: "var(--text-secondary)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: "60vh",
          overflowY: "auto",
          lineHeight: 1.5,
        }}
      >
        {prompt || "(empty)"}
      </pre>
    </div>
  );
}
