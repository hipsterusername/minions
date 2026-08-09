import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DisplayMessage } from "../../sdk-messages.ts";
import type { SessionStreamState, SessionStreamStatus } from "../../session-stream.ts";
import { useSessionStream } from "../../use-session-stream.ts";
import type { SocketSubscribe } from "../../use-socket.ts";
import { SimpleMarkdown } from "../../components/SimpleMarkdown.tsx";
import type { TaskPlanItem } from "./types.ts";

const STATUS_COLOR: Record<TaskPlanItem["status"], string> = {
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

const ROLE_LABEL: Record<DisplayMessage["role"], string> = {
  user: "Task",
  assistant: "Minion",
  result: "Result",
  system: "Status",
  thinking: "Thinking",
  tool: "Tool",
};

export interface MinionsSurfaceProps {
  tasks: TaskPlanItem[];
  selectedTaskId?: string | null | undefined;
  onSelectTask?: ((taskId: string) => void) | undefined;
  socketSend?: ((data: unknown) => void) | undefined;
  socketSubscribe?: SocketSubscribe | ((fn: (msg: unknown) => void) => () => void) | undefined;
}

function taskStreamStatus(status: TaskPlanItem["status"]): SessionStreamStatus {
  if (status === "starting") return "creating";
  if (status === "running") return "running";
  if (status === "completed") return "completed";
  if (status === "failed" || status === "orphaned") return "error";
  if (status === "cancelled" || status === "ended_without_report") return "stopped";
  return "idle";
}

function emptyStream(task: TaskPlanItem): SessionStreamState {
  return {
    sessionKey: task.minionSessionKey,
    status: taskStreamStatus(task.status),
    messages: [],
    streamingText: "",
    streamingBlockIndex: null,
    totalCost: task.cost,
    turns: 0,
    error: null,
  };
}

function preferredTask(tasks: TaskPlanItem[]): TaskPlanItem | undefined {
  return tasks.find((task) => task.status === "running" || task.status === "starting") ?? tasks[0];
}

export function MinionsSurface({
  tasks,
  selectedTaskId,
  onSelectTask,
  socketSend,
  socketSubscribe,
}: MinionsSurfaceProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const syncedKeysRef = useRef(new Set<string>());
  const [isCompact, setIsCompact] = useState(false);
  const [streams, setStreams] = useState<Record<string, SessionStreamState>>({});

  const minionTasks = useMemo(() => tasks.filter((task) => task.executor === "minion"), [tasks]);
  const selectedTask =
    minionTasks.find((task) => task.taskId === selectedTaskId) ?? preferredTask(minionTasks);
  const selectedKey = selectedTask?.minionSessionKey ?? null;
  const selectedStream = selectedTask
    ? selectedKey
      ? streams[selectedKey] ?? emptyStream(selectedTask)
      : emptyStream(selectedTask)
    : null;

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setIsCompact(entry.contentRect.width < 460);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!selectedTask || selectedTaskId === selectedTask.taskId) return;
    onSelectTask?.(selectedTask.taskId);
  }, [selectedTask, selectedTaskId, onSelectTask]);

  useEffect(() => {
    if (!selectedKey || !socketSend || syncedKeysRef.current.has(selectedKey)) return;
    syncedKeysRef.current.add(selectedKey);
    socketSend({ type: "sync_session", sessionKey: selectedKey });
  }, [selectedKey, socketSend]);

  const handleStreamChange = useCallback((next: SessionStreamState) => {
    if (!next.sessionKey) return;
    setStreams((current) => ({ ...current, [next.sessionKey!]: next }));
  }, []);

  useSessionStream({
    socketSubscribe,
    state: selectedStream ?? {
      sessionKey: null,
      status: "disconnected",
      messages: [],
      streamingText: "",
      streamingBlockIndex: null,
      totalCost: 0,
      turns: 0,
      error: null,
    },
    onChange: handleStreamChange,
    prefix: "leader-minion",
  });

  if (!selectedTask || !selectedStream) return null;

  const selectedIndex = minionTasks.findIndex((task) => task.taskId === selectedTask.taskId);
  return (
    <div
      ref={rootRef}
      data-testid="minions-surface"
      style={{
        flex: 1,
        minHeight: 0,
        display: "grid",
        gridTemplateColumns: isCompact ? "minmax(0, 1fr)" : "minmax(150px, 0.72fr) minmax(0, 1.55fr)",
        gridTemplateRows: isCompact ? "minmax(96px, auto) minmax(0, 1fr)" : "minmax(0, 1fr)",
        background: "var(--bg-primary)",
        overflow: "hidden",
      }}
    >
      <div
        data-scroll-capture
        aria-label="Minions"
        style={{
          minWidth: 0,
          minHeight: 0,
          overflow: "auto",
          padding: 10,
          display: "grid",
          alignContent: "start",
          gridTemplateColumns: isCompact ? "repeat(auto-fit, minmax(150px, 1fr))" : "minmax(0, 1fr)",
          gap: 7,
          borderRight: isCompact ? "none" : "1px solid var(--border-default)",
          borderBottom: isCompact ? "1px solid var(--border-default)" : "none",
          background: "var(--bg-secondary)",
        }}
      >
        {minionTasks.map((task, index) => (
          <MinionCard
            key={task.taskId}
            task={task}
            index={index}
            selected={task.taskId === selectedTask.taskId}
            onClick={() => onSelectTask?.(task.taskId)}
          />
        ))}
      </div>

      <MinionDetail
        key={selectedTask.taskId}
        task={selectedTask}
        index={selectedIndex}
        stream={selectedStream}
      />
    </div>
  );
}

function MinionCard({
  task,
  index,
  selected,
  onClick,
}: {
  task: TaskPlanItem;
  index: number;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`Minion ${index + 1}: ${task.title}`}
      onClick={onClick}
      style={{
        width: "100%",
        minWidth: 0,
        padding: "9px 10px",
        display: "grid",
        gridTemplateColumns: "8px minmax(0, 1fr)",
        columnGap: 8,
        rowGap: 3,
        textAlign: "left",
        borderRadius: 7,
        border: `1px solid ${selected ? "color-mix(in srgb, var(--accent) 42%, var(--border-default))" : "var(--border-subtle, var(--border-default))"}`,
        background: selected ? "color-mix(in srgb, var(--accent) 9%, var(--bg-surface))" : "var(--bg-surface)",
        boxShadow: selected ? "0 0 0 1px color-mix(in srgb, var(--accent) 10%, transparent)" : "none",
        cursor: "pointer",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          marginTop: 3,
          borderRadius: "50%",
          background: STATUS_COLOR[task.status],
          boxShadow: task.status === "running" ? `0 0 0 3px color-mix(in srgb, ${STATUS_COLOR.running} 16%, transparent)` : "none",
        }}
      />
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 11, fontWeight: 650, lineHeight: 1.2, color: "var(--text-primary)" }}>
          Minion {String(index + 1).padStart(2, "0")}
        </span>
        <span style={{ display: "block", marginTop: 4, fontSize: 9, lineHeight: 1.2, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.45 }}>
          Active task
        </span>
        <span style={{ display: "block", marginTop: 2, fontSize: 11, lineHeight: 1.35, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {task.title}
        </span>
      </span>
    </button>
  );
}

function MinionDetail({ task, index, stream }: { task: TaskPlanItem; index: number; stream: SessionStreamState }) {
  const outputRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [stream.messages.length, stream.streamingText]);

  const progress = task.progress ?? [];
  const visibleMessages = stream.messages.filter((message) => message.role !== "tool");
  const hasActivity = visibleMessages.length > 0 || !!stream.streamingText || progress.length > 0 || !!task.sessionSummary;
  return (
    <section style={{ minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--bg-surface)" }}>
      <header style={{ padding: "11px 14px", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, borderBottom: "1px solid var(--border-default)" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontSize: 12, fontWeight: 650, color: "var(--text-primary)" }}>Minion {String(index + 1).padStart(2, "0")}</span>
            <span style={{ fontSize: 9, color: STATUS_COLOR[task.status], fontFamily: "var(--font-mono)", textTransform: "uppercase" }}>{task.status.replaceAll("_", " ")}</span>
          </div>
          <h3 style={{ margin: "5px 0 0", fontSize: 13, lineHeight: 1.35, fontWeight: 600, color: "var(--text-primary)" }}>{task.title}</h3>
          {task.activeStep && <p style={{ margin: "4px 0 0", fontSize: 10, lineHeight: 1.4, color: "var(--status-creating)", fontFamily: "var(--font-mono)" }}>{task.activeStep}</p>}
        </div>
        {stream.totalCost > 0 && <span style={{ flexShrink: 0, fontSize: 9, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>${stream.totalCost.toFixed(4)}</span>}
      </header>

      <div ref={outputRef} data-scroll-capture style={{ flex: 1, minHeight: 0, overflow: "auto", overscrollBehavior: "contain", padding: 12 }}>
        <div style={{ padding: "9px 10px", borderRadius: 6, background: "var(--bg-secondary)", border: "1px solid var(--border-subtle, var(--border-default))" }}>
          <div style={{ fontSize: 9, fontWeight: 650, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>Task brief</div>
          <div style={{ marginTop: 5, fontSize: 11, lineHeight: 1.45, color: "var(--text-secondary)" }}>{task.description || task.title}</div>
        </div>

        <div style={{ margin: "14px 0 7px", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 9, fontWeight: 650, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>Activity</span>
          <span style={{ height: 1, flex: 1, background: "var(--border-subtle, var(--border-default))" }} />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {visibleMessages.map((message) => <ActivityEntry key={message.id} message={message} />)}
          {progress.map((item, itemIndex) => (
            <ActivityEntry key={`progress-${itemIndex}`} message={{ id: `progress-${itemIndex}`, role: "system", content: item, timestamp: 0 }} />
          ))}
          {stream.messages.length === 0 && task.sessionSummary && !task.result && (
            <ActivityEntry message={{ id: "session-summary", role: "assistant", content: task.sessionSummary, timestamp: task.completedAt ?? 0 }} />
          )}
          {stream.streamingText && (
            <div style={{ padding: "8px 9px", borderRadius: 6, background: "color-mix(in srgb, var(--accent) 7%, var(--bg-primary))", color: "var(--text-secondary)", fontSize: 11, lineHeight: 1.45 }}>
              <SimpleMarkdown text={stream.streamingText} />
            </div>
          )}
          {!hasActivity && <div style={{ padding: "18px 8px", textAlign: "center", fontSize: 11, lineHeight: 1.5, color: "var(--text-muted)" }}>{task.minionSessionKey ? "Waiting for the first log entry…" : "This subagent reports progress through the leader."}</div>}
          {task.result && <div style={{ padding: "9px 10px", borderRadius: 6, background: task.status === "completed" ? "var(--success-bg)" : "var(--warning-bg)", color: task.status === "completed" ? "var(--success-color)" : "var(--text-secondary)", fontSize: 11, lineHeight: 1.45 }}><SimpleMarkdown text={task.result} /></div>}
        </div>
      </div>
    </section>
  );
}

function ActivityEntry({ message }: { message: DisplayMessage }) {
  const isMarkdown = message.role === "assistant" || message.role === "result";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "52px minmax(0, 1fr)", gap: 8, padding: "7px 8px", borderRadius: 6, background: message.role === "result" ? "var(--success-bg)" : "var(--bg-primary)", border: "1px solid var(--border-subtle, var(--border-default))" }}>
      <span style={{ fontSize: 9, color: message.role === "result" ? "var(--success-color)" : "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{ROLE_LABEL[message.role]}</span>
      <div style={{ minWidth: 0, fontSize: 11, lineHeight: 1.45, color: "var(--text-secondary)", whiteSpace: isMarkdown ? "normal" : "pre-wrap", overflowWrap: "anywhere" }}>
        {isMarkdown ? <SimpleMarkdown text={message.content} /> : message.content}
      </div>
    </div>
  );
}
