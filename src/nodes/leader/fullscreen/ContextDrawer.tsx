import { CrewIcon } from "../../../components/CrewIcon.tsx";
import { MinionsIcon } from "../../../components/MinionsIcon.tsx";
import { useEffect, useId, useState, type ReactNode, type RefObject } from "react";
import { buildLeaderSystemPrompt } from "../../../prompts/build-leader-prompt.ts";
import { CopyButton } from "../../../components/CopyButton.tsx";
import type { LeaderData } from "../types.ts";
import type { ContextItem } from "../../../types.ts";
import { selectCanvasChangeMode } from "../work-item.ts";

type TabId = "overview" | "graph" | "worktree" | "approval" | "skills" | "prompt" | "sources";

export function ContextDrawer({ data, onUpdateData, skillFlyoutAnchorRef,
  onOpenSkillFlyout, graphProjection, onOpenGraph, configSlot, contextItems = [], reviewRequest = 0,
}: {
  data: LeaderData;
  onUpdateData: (next: LeaderData) => void;
  skillFlyoutAnchorRef: RefObject<HTMLElement | null>;
  onOpenSkillFlyout: () => void;
  graphProjection?: { title: string; status: string; detail: string } | null | undefined;
  onOpenGraph?: (() => void) | undefined;
  configSlot?: ReactNode;
  reviewRequest?: number;
  contextItems?: ContextItem[] | undefined;
}) {
  const id = useId();
  const isWorktreeMode = selectCanvasChangeMode(data) === "worktree";
  const approvalPending = isWorktreeMode && !!data.approvalPending;
  const [activeTab, setActiveTab] = useState<TabId>(approvalPending ? "approval" : "overview");
  useEffect(() => {
    if ((!isWorktreeMode && activeTab === "approval") || (!graphProjection && activeTab === "graph")) setActiveTab("overview");
  }, [activeTab, graphProjection, isWorktreeMode]);
  useEffect(() => { if (reviewRequest > 0) setActiveTab(isWorktreeMode ? "approval" : "worktree"); }, [reviewRequest, isWorktreeMode]);
  const tabs: { id: TabId; label: string; badge?: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "sources", label: `Sources · ${contextItems.length}` },
    { id: "worktree", label: "Settings" },
    ...(isWorktreeMode ? [{ id: "approval" as const, label: "Changes", ...(approvalPending ? { badge: "•" } : {}) }] : []),
    ...(graphProjection ? [{ id: "graph" as const, label: "Graph" }] : []),
    { id: "skills", label: `Skills · ${data.skillIds.length}` },
    { id: "prompt", label: "Prompt" },
  ];
  return <aside className="leader-fs-drawer" data-testid="leader-fullscreen-context-drawer">
    <div className="leader-fs-context-tabs" role="tablist" aria-label="Context drawer tabs">
      {tabs.map((tab, index) => <button key={tab.id} id={`${id}-${tab.id}`} role="tab"
        aria-selected={activeTab === tab.id} aria-controls={`${id}-panel`} tabIndex={activeTab === tab.id ? 0 : -1}
        data-testid={`drawer-tab-${tab.id}`} onClick={() => setActiveTab(tab.id)}
        onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
            : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length
            : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
          if (next === null) return;
          event.preventDefault(); setActiveTab(tabs[next]!.id);
          document.getElementById(`${id}-${tabs[next]!.id}`)?.focus();
        }}>{tab.id === "graph" && <CrewIcon size={14} />} {tab.label}{tab.badge && <span aria-label="Review pending"> {tab.badge}</span>}</button>)}
    </div>
    <div className="leader-fs-context-content" id={`${id}-panel`} role="tabpanel" tabIndex={0}
      aria-labelledby={`${id}-${activeTab}`} data-testid={`drawer-panel-${activeTab}`}>
      {activeTab === "overview" && <OverviewPanel data={data} />}
      {activeTab === "sources" && <SourcesPanel items={contextItems} />}
      {activeTab === "graph" && graphProjection && <GraphPanel projection={graphProjection} onOpen={onOpenGraph} />}
      {activeTab === "worktree" && <WorktreePanel data={data} />}
      {activeTab === "approval" && <ApprovalPanel data={data} />}
      <div hidden={activeTab !== "worktree" && activeTab !== "approval"} className="leader-fs-config">{configSlot}</div>
      {activeTab === "skills" && <SkillsPanel data={data} onUpdateData={onUpdateData} anchorRef={skillFlyoutAnchorRef} onOpen={onOpenSkillFlyout} />}
      {activeTab === "prompt" && <PromptPanel data={data} />}
    </div>
  </aside>;
}

function SourcesPanel({ items }: { items: ContextItem[] }) {
  return <div className="leader-fs-source-list">
    <h3>Connected sources</h3>
    <p className="leader-fs-muted">Current context connected on the canvas. Preview each source to check its relevance before your next message.</p>
    {items.length === 0 && <p>No connected sources. Return to the canvas to connect files, notes, images, or another leader.</p>}
    {items.map(item => <details key={item.nodeId} className="leader-fs-source">
      <summary><strong>{item.label || item.nodeType}</strong><span>{item.nodeType} · {item.content.length.toLocaleString()} characters{item.attachments?.length ? ` · ${item.attachments.length} attachments` : ""}</span></summary>
      <pre>{item.content || "This source contains attachments only."}</pre>
    </details>)}
  </div>;
}

function GraphPanel({ projection, onOpen }: {
  projection: { title: string; status: string; detail: string };
  onOpen?: (() => void) | undefined;
}) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
    <div style={{ padding: "10px 12px", background: "var(--bg-elevated)",
      border: "1px solid var(--border-default)", borderRadius: 6 }}>
      <div style={{ color: "var(--text-primary)", fontWeight: 700 }}>{projection.title}</div>
      <div style={{ marginTop: 4, color: "var(--text-muted)", fontFamily: "var(--font-mono)",
        fontSize: 10 }}>{projection.status} · {projection.detail}</div>
    </div>
    <button type="button" onClick={onOpen} disabled={!onOpen}
      style={{ padding: "7px 10px", border: "1px solid var(--accent)", borderRadius: 5,
        background: "var(--accent)", color: "var(--text-on-accent)", cursor: "pointer",
        fontWeight: 700 }}>Open graph details</button>
    <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 10 }}>
      Inspect dependencies, task outcomes, and any decisions needed to continue.
    </p>
  </div>;
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
        <span>Task progress · completed</span>
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
      (t) => t.status === "completed",
    ).length ?? 0;
  const runningTasks =
    data.taskPlan?.filter((t) => t.status === "running" || t.status === "starting").length ?? 0;
  const minionTasks =
    data.taskPlan?.filter((t) => t.executor === "minion").length ?? 0;
  const skillCount = data.skillIds?.length ?? 0;
  const avgCostPerTurn = data.turns > 0 ? data.totalCost / data.turns : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 6 }}>
        <HeroMetric
          label="Leader cost"
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

      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        <StatRow label="Status" value={data.status} />
        <StatRow label="Needs attention" value={data.taskPlan.filter(t => ["failed", "blocked", "orphaned", "ended_without_report"].includes(t.status)).length} />
        <StatRow label="Cancelled" value={data.taskPlan.filter(t => t.status === "cancelled").length} />
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
          <MinionsIcon name="wait" size={13} /> Waiting · {Math.ceil((data.waitUntil - Date.now()) / 1000)}s
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
        No pending approval. Use the review controls below to inspect available changes.
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
        Review changes and available integration actions below.
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
        <MinionsIcon name="skill" size={13} /> Manage skills {skillIds.length > 0 ? `(${skillIds.length})` : ""}
      </button>
      <ul className="leader-fs-skill-list">{skillIds.map(id => <li key={id}>{id}</li>)}</ul>
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
      <p className="leader-fs-muted">Instruction preview from the current setup. Runtime instructions, connected sources, and the session’s frozen skill snapshot may differ.</p>
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
