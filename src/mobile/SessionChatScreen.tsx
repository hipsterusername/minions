import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";

import type { DisplayMessage } from "../sdk-messages.ts";
import { toolDisplayInfo } from "../nodes/leader-message-helpers.ts";
import {
  RenderComponentView,
  gridColumnFor,
  injectStyles as injectRenderStyles,
} from "../nodes/RenderNode.tsx";
import {
  emptySessionStreamState,
  type SessionStreamState,
} from "../session-stream.ts";
import { useSessionStream } from "../use-session-stream.ts";
import {
  type ActiveMinion,
  type SocketSubscribe,
  type SyncTaskRecord,
} from "../use-socket.ts";
import {
  emptyRenderState,
  type RenderState,
} from "../../shared/render-dsl.ts";
import {
  TEXT_ATTACHMENT_ACCEPT,
  appendTextAttachmentsToPrompt,
  fileToImageAttachment,
  fileToTextAttachment,
  isAcceptedImageType,
  isAcceptedTextFile,
  type ImageAttachment,
  type TextAttachment,
} from "./attachments.ts";
import type { MobileSessionInfo } from "./mobile-selectors.ts";
import {
  activeMinionSummary,
  sessionDisplayTitle,
  sessionRoleLabel,
} from "./mobile-selectors.ts";

/** Statuses where the leader is actively doing work right now. */
const LEADER_LIVE_STATUSES = new Set(["running", "creating", "waiting"]);

interface SessionChatScreenProps {
  sessionKey: string;
  session?: MobileSessionInfo | undefined;
  subscribe: SocketSubscribe;
  send: (data: unknown) => void;
  onBack: () => void;
}

type ChatTab = "chat" | "plan" | "dashboard";

function messageTone(message: DisplayMessage): string {
  if (message.role === "tool" || message.role === "result") return "tool";
  if (message.role === "thinking" || message.role === "system") return "context";
  return message.role;
}

function MessageBubble({ message }: { message: DisplayMessage }) {
  const toolInfo = message.role === "tool" ? toolDisplayInfo(message.toolName, message.toolInput) : null;
  const label = toolInfo?.label ?? message.toolName ?? message.role;
  const body = toolInfo?.summary ?? (message.content || message.toolName || "Tool activity");
  return (
    <article
      className={`mob-message mob-message--${message.role}`}
      data-tone={messageTone(message)}
      data-tool-kind={toolInfo?.kind}
      aria-label={message.role === "user" ? "You" : undefined}
    >
      <div className="mob-message-label">
        {toolInfo ? <span className="mob-tool-icon" aria-hidden="true">{toolInfo.icon}</span> : null}
        <span className="mob-message-label-text">{label}</span>
      </div>
      <div className="mob-message-content">
        {body}
      </div>
      {message.suffix ? <div className="mob-message-suffix">{message.suffix}</div> : null}
    </article>
  );
}

function SessionCallout({ session }: { session?: MobileSessionInfo | undefined }) {
  if (!session) return null;
  const metric = `${session.turns ?? 0} turns`;
  const cost =
    session.totalCost == null || !Number.isFinite(session.totalCost)
      ? "$0.00"
      : session.totalCost > 0 && session.totalCost < 0.01
        ? `$${session.totalCost.toFixed(4)}`
        : `$${session.totalCost.toFixed(2)}`;

  return (
    <section className="mob-chat-callout" data-status={session.status} aria-label="Session status">
      <div>
        <span className={`mob-status-pill mob-status-pill--${session.status}`}>
          {session.status}
        </span>
        {session.model ? <span className="mob-chat-model">{session.model}</span> : null}
      </div>
      <strong>{cost} · {metric}</strong>
      {session.lastActivity ? <p>{session.lastActivity}</p> : null}
    </section>
  );
}

/**
 * Compact, always-visible activity strip for a leader session. Unlike the
 * chat-feed callout it stays pinned under the tab bar, so the leader's live
 * status and its active-minion roster remain legible on the Plan and Dashboard
 * tabs — not just while reading the conversation.
 */
function LeaderActivityStrip({ session }: { session: MobileSessionInfo }) {
  const summary = activeMinionSummary(session);
  const live = LEADER_LIVE_STATUSES.has(session.status);
  return (
    <section
      className="mob-leader-strip"
      data-status={session.status}
      data-live={live ? "true" : "false"}
      aria-label="Leader activity"
    >
      <div className="mob-leader-strip-row">
        <span
          className={`mob-status-pill mob-status-pill--${session.status}`}
          data-live={live ? "true" : "false"}
        >
          {session.status}
        </span>
        {summary.total > 0 ? (
          <span className="mob-leader-strip-minions" aria-label="Active minions summary">
            {summary.running > 0 ? (
              <span data-tone="running" data-live="true">
                <i aria-hidden="true" />
                {summary.running} running
              </span>
            ) : null}
            {summary.blocked > 0 ? <span data-tone="blocked">{summary.blocked} blocked</span> : null}
            {summary.planned > 0 ? <span data-tone="planned">{summary.planned} queued</span> : null}
          </span>
        ) : (
          <span className="mob-leader-strip-empty">No active minions</span>
        )}
      </div>
      {session.lastActivity ? (
        <p className="mob-leader-strip-activity">{session.lastActivity}</p>
      ) : null}
    </section>
  );
}

type MinionStatusTone = "running" | "blocked" | "planned" | "idle";

function minionStatusTone(status: string): MinionStatusTone {
  switch (status) {
    case "running":
    case "starting":
      return "running";
    case "blocked":
      return "blocked";
    case "planned":
      return "planned";
    default:
      return "idle";
  }
}

function statusLabel(status: string): string {
  return status.replace(/[-_]/g, " ");
}

function ActiveMinionsDashboard({ minions }: { minions: ActiveMinion[] }) {
  if (minions.length === 0) return null;

  const counts = minions.reduce(
    (acc, minion) => {
      const tone = minionStatusTone(minion.status);
      acc[tone] += 1;
      return acc;
    },
    { running: 0, blocked: 0, planned: 0, idle: 0 },
  );
  const runningShare = Math.max(8, Math.round(((counts.running + counts.blocked) / minions.length) * 100));

  return (
    <section className="mob-minion-dashboard" aria-label="Active minions">
      <div className="mob-minion-dashboard-head">
        <div>
          <span className="mob-minion-eyebrow">Minion dashboard</span>
          <strong>{minions.length} active</strong>
        </div>
        <div className="mob-minion-counts" aria-label="Minion status counts">
          {counts.running > 0 ? <span data-tone="running">{counts.running} running</span> : null}
          {counts.blocked > 0 ? <span data-tone="blocked">{counts.blocked} blocked</span> : null}
          {counts.planned > 0 ? <span data-tone="planned">{counts.planned} planned</span> : null}
        </div>
      </div>
      <div className="mob-minion-progress" aria-hidden="true">
        <span style={{ width: `${runningShare}%` }} />
      </div>
      <div className="mob-minion-list">
        {minions.map((minion) => {
          const tone = minionStatusTone(minion.status);
          const key = minion.sessionKey ?? minion.taskId;
          return (
            <article className="mob-minion-row" data-tone={tone} key={key}>
              <span className="mob-minion-dot" aria-hidden="true" />
              <div className="mob-minion-main">
                <strong>{minion.title || minion.taskId}</strong>
                <span>{minion.taskId}</span>
              </div>
              <span className="mob-minion-state">{statusLabel(minion.status)}</span>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function taskStatusLabel(status: string): string {
  return status.replace(/[_-]/g, " ");
}

function taskStatusTone(status: string): string {
  switch (status) {
    case "running":
    case "starting":
      return "running";
    case "blocked":
      return "blocked";
    case "completed":
      return "completed";
    case "failed":
    case "ended_without_report":
    case "orphaned":
      return "failed";
    default:
      return "idle";
  }
}

function isDoneTask(status: string): boolean {
  return ["completed", "failed", "ended_without_report", "cancelled", "orphaned"].includes(status);
}

function isCurrentTask(status: string): boolean {
  return status === "running" || status === "starting";
}

function priorityLabel(priority: SyncTaskRecord["priority"]): string {
  return priority === "critical" ? "crit" : priority;
}

function executorLabel(task: SyncTaskRecord): string {
  if (task.executor === "leader") return task.status === "completed" ? "self done" : "self";
  if (task.status === "blocked") return "needs input";
  if (isCurrentTask(task.status)) return "minion working";
  if (task.status === "completed") return "minion done";
  if (task.status === "failed") return "minion failed";
  return "minion";
}

function unplannedMinionsFor(tasks: SyncTaskRecord[], minions: ActiveMinion[]): ActiveMinion[] {
  const taskKeys = new Set<string>();
  for (const task of tasks) {
    taskKeys.add(task.taskId);
    if (task.minionSessionKey) taskKeys.add(task.minionSessionKey);
  }
  return minions.filter((minion) => {
    const key = minion.sessionKey ?? minion.taskId;
    return !taskKeys.has(minion.taskId) && !taskKeys.has(key);
  });
}

function taskProgressSummary(tasks: SyncTaskRecord[], minions: ActiveMinion[]) {
  const unplannedMinions = unplannedMinionsFor(tasks, minions);
  const done = tasks.filter((task) => isDoneTask(task.status)).length;
  const blocked = tasks.filter((task) => task.status === "blocked").length
    + unplannedMinions.filter((minion) => minion.status === "blocked").length;
  const current = tasks.filter((task) => isCurrentTask(task.status)).length
    + unplannedMinions.filter((minion) => isCurrentTask(minion.status)).length;
  const planned = tasks.filter((task) => task.status === "planned").length;
  return { done, blocked, current, planned, total: tasks.length };
}

function PlanTaskRow({ task }: { task: SyncTaskRecord }) {
  const hasDetails = Boolean(task.description || task.result || task.minionSessionKey);
  const body = (
    <>
      <span className="mob-plan-dot" aria-hidden="true" />
      <span className="mob-plan-row-main">
        <span className="mob-plan-title">{task.title || task.taskId}</span>
        <span className="mob-plan-subline">
          <span>{executorLabel(task)}</span>
          <span>{taskStatusLabel(task.status)}</span>
          <span data-priority={task.priority}>{priorityLabel(task.priority)}</span>
        </span>
      </span>
    </>
  );

  if (!hasDetails) {
    return (
      <article className="mob-plan-row" data-tone={taskStatusTone(task.status)}>
        {body}
      </article>
    );
  }

  return (
    <details className="mob-plan-row" data-tone={taskStatusTone(task.status)}>
      <summary className="mob-plan-summary">
        {body}
      </summary>
      <div className="mob-plan-details">
        {task.description ? (
          <p>
            <span>Goal</span>
            {task.description}
          </p>
        ) : null}
        {task.result ? (
          <p>
            <span>Result</span>
            {task.result}
          </p>
        ) : null}
        {task.minionSessionKey ? <code>{task.minionSessionKey}</code> : null}
      </div>
    </details>
  );
}

function PlanGroup({
  title,
  tasks,
}: {
  title: string;
  tasks: SyncTaskRecord[];
}) {
  if (tasks.length === 0) return null;
  return (
    <section className="mob-plan-group" aria-label={title}>
      <header className="mob-plan-group-head">
        <span>{title}</span>
        <strong>{tasks.length}</strong>
      </header>
      <div className="mob-plan-list">
        {tasks.map((task) => (
          <PlanTaskRow task={task} key={task.taskId} />
        ))}
      </div>
    </section>
  );
}

function UnplannedMinions({ minions, tasks }: { minions: ActiveMinion[]; tasks: SyncTaskRecord[] }) {
  const unplanned = unplannedMinionsFor(tasks, minions);
  if (unplanned.length === 0) return null;
  return <ActiveMinionsDashboard minions={unplanned} />;
}

function PlanMinionPanel({
  tasks,
  minions,
}: {
  tasks: SyncTaskRecord[];
  minions: ActiveMinion[];
}) {
  const summary = taskProgressSummary(tasks, minions);
  const progress = summary.total > 0 ? Math.round((summary.done / summary.total) * 100) : 0;
  const attention = tasks.filter((task) => task.status === "blocked");
  const current = tasks.filter((task) => isCurrentTask(task.status));
  const next = tasks.filter((task) => task.status === "planned");
  const finished = tasks.filter((task) => isDoneTask(task.status));

  return (
    <div className="mob-tab-panel mob-plan-panel" role="tabpanel" aria-label="Plan and minions">
      {tasks.length > 0 ? (
        <section className="mob-plan-overview" aria-label="Task plan">
          <div className="mob-plan-overview-head">
            <div>
              <span>Plan</span>
              <strong>{summary.done}/{summary.total} complete</strong>
            </div>
            <div className="mob-plan-overview-stats" aria-label="Plan status counts">
              {summary.blocked > 0 ? <span data-tone="blocked">{summary.blocked} blocked</span> : null}
              {summary.current > 0 ? <span data-tone="running">{summary.current} active</span> : null}
              {summary.planned > 0 ? <span>{summary.planned} queued</span> : null}
            </div>
          </div>
          <div className="mob-plan-progress" aria-label={`${progress}% complete`}>
            <span style={{ width: `${progress}%` }} />
          </div>
        </section>
      ) : (
        <div className="mob-empty mob-empty--panel" role="status">
          <h2>No plan yet</h2>
          <p>The leader has not published task plan items.</p>
        </div>
      )}

      <PlanGroup title="Needs Attention" tasks={attention} />
      <PlanGroup title="In Progress" tasks={current} />
      <PlanGroup title="Up Next" tasks={next} />
      <PlanGroup title="Finished" tasks={finished} />
      <UnplannedMinions minions={minions} tasks={tasks} />
    </div>
  );
}

function MobileDashboardPanel({
  renderState,
  sessionKey,
  send,
}: {
  renderState: RenderState;
  sessionKey: string;
  send: (data: unknown) => void;
}) {
  if (renderState.components.length === 0) {
    return (
      <div className="mob-tab-panel mob-dashboard-panel" role="tabpanel" aria-label="Rendered dashboard">
        <div className="mob-empty mob-empty--panel" role="status">
          <h2>No dashboard yet</h2>
          <p>The leader renders dashboard content here as it works.</p>
        </div>
      </div>
    );
  }

  const columns = renderState.layout.columns ?? 2;
  const gap = renderState.layout.gap ?? 12;

  return (
    <div className="mob-tab-panel mob-dashboard-panel" role="tabpanel" aria-label="Rendered dashboard">
      {renderState.layout.title ? (
        <div className="mob-dashboard-title">{renderState.layout.title}</div>
      ) : null}
      <div
        className="rd-grid-container mob-dashboard-grid-container"
        style={{
          containerType: "inline-size",
          ["--rd-max-cols" as string]: String(columns),
          ["--rd-gap" as string]: `${gap}px`,
        }}
      >
        <div
          className="rd-grid"
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(var(--rd-cols, ${columns}), minmax(0, 1fr))`,
            gap,
            alignContent: "start",
            alignItems: "start",
            gridAutoRows: "min-content",
            gridAutoFlow: "dense",
          }}
        >
          {renderState.components.map((component) => (
            <div
              key={component.id}
              style={{ gridColumn: gridColumnFor(component, columns), minWidth: 0 }}
            >
              <RenderComponentView
                component={component}
                context={{
                  onSubmitForm: (componentId, answers) =>
                    send({ type: "submit_form", sessionKey, componentId, answers }),
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function SessionChatScreen({
  sessionKey,
  session,
  subscribe,
  send,
  onBack,
}: SessionChatScreenProps) {
  const [state, setState] = useState<SessionStreamState>(() =>
    emptySessionStreamState(sessionKey),
  );
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [textAttachments, setTextAttachments] = useState<TextAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [composerFocused, setComposerFocused] = useState(false);
  const [activeTab, setActiveTab] = useState<ChatTab>("chat");
  const feedRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const renderState = session?.renderState ?? emptyRenderState();

  useEffect(() => {
    injectRenderStyles();
  }, []);

  useEffect(() => {
    setState(emptySessionStreamState(sessionKey));
    setActiveTab("chat");
    send({ type: "sync_session", sessionKey });
  }, [send, sessionKey]);

  useSessionStream({
    socketSubscribe: subscribe,
    state,
    onChange: setState,
    prefix: "mob",
  });

  useEffect(() => {
    const feed = feedRef.current;
    if (!feed) return;
    requestAnimationFrame(() => {
      if (typeof feed.scrollTo === "function") {
        feed.scrollTo({ top: feed.scrollHeight, behavior: "smooth" });
      } else {
        feed.scrollTop = feed.scrollHeight;
      }
    });
  }, [state.messages.length, state.streamingText, composerFocused]);

  const title = useMemo(() => {
    if (!session) return sessionKey;
    return sessionDisplayTitle(session);
  }, [session, sessionKey]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed && attachments.length === 0 && textAttachments.length === 0) return;
    send({
      type: "send_message",
      sessionKey,
      prompt: appendTextAttachmentsToPrompt(trimmed, textAttachments),
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    setPrompt("");
    setAttachments([]);
    setTextAttachments([]);
    setAttachmentError(null);
  }

  async function handleAttachChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length === 0) return;

    const imageFiles = files.filter((file) => isAcceptedImageType(file.type));
    const textFiles = files.filter((file) => !isAcceptedImageType(file.type) && isAcceptedTextFile(file));
    const rejectedCount = files.length - imageFiles.length - textFiles.length;
    const [imageSettled, textSettled] = await Promise.all([
      Promise.allSettled(imageFiles.map((file) => fileToImageAttachment(file))),
      Promise.allSettled(textFiles.map((file) => fileToTextAttachment(file))),
    ]);
    const acceptedImages = imageSettled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const acceptedText = textSettled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const failedCount =
      rejectedCount
      + imageSettled.filter((result) => result.status === "rejected").length
      + textSettled.filter((result) => result.status === "rejected").length;

    if (acceptedImages.length > 0) {
      setAttachments((current) => [...current, ...acceptedImages]);
    }
    if (acceptedText.length > 0) {
      setTextAttachments((current) => [...current, ...acceptedText]);
    }
    setAttachmentError(
      failedCount > 0
        ? "Some files were not supported. Use images or text files such as TXT, Markdown, HTML, JSON, CSV, or code."
        : null,
    );
  }

  function removeAttachment(index: number) {
    setAttachments((current) => current.filter((_, i) => i !== index));
  }

  function removeTextAttachment(index: number) {
    setTextAttachments((current) => current.filter((_, i) => i !== index));
  }

  const canSend = prompt.trim().length > 0 || attachments.length > 0 || textAttachments.length > 0;
  const promptLength = prompt.trim().length;
  const activeMinions = session?.role === "leader" ? (session.activeMinions ?? []) : [];
  const taskPlan = session?.role === "leader" ? (session.taskPlan ?? []) : [];
  const isLeader = session?.role === "leader";
  const hasDashboard = renderState.components.length > 0;
  const planTotal = taskPlan.length || activeMinions.length;
  const liveWork =
    activeMinions.filter((minion) => isCurrentTask(minion.status)).length
    + taskPlan.filter((task) => isCurrentTask(task.status)).length;

  return (
    <main className="mob-chat" aria-label="Session chat">
      <header className="mob-chat-header">
        <button className="mob-icon-button" type="button" onClick={onBack} aria-label="Back to activity">
          ←
        </button>
        <div className="mob-chat-title">
          <span>{session ? sessionRoleLabel(session) : "Session"}</span>
          <h1>{title}</h1>
        </div>
        <button
          className="mob-stop-button"
          type="button"
          onClick={() => send({ type: "stop_session", sessionKey })}
        >
          Stop
        </button>
      </header>

      {isLeader ? (
        <nav className="mob-chat-tabs" aria-label="Leader session views">
          <button
            type="button"
            className="mob-chat-tab"
            data-active={activeTab === "chat" ? "true" : "false"}
            onClick={() => setActiveTab("chat")}
          >
            Chat
          </button>
          <button
            type="button"
            className="mob-chat-tab"
            data-active={activeTab === "plan" ? "true" : "false"}
            onClick={() => setActiveTab("plan")}
          >
            Plan
            {planTotal > 0 ? (
              <span data-live={liveWork > 0 ? "true" : "false"}>{planTotal}</span>
            ) : null}
          </button>
          <button
            type="button"
            className="mob-chat-tab"
            data-active={activeTab === "dashboard" ? "true" : "false"}
            onClick={() => setActiveTab("dashboard")}
          >
            Dashboard
            {hasDashboard ? <span>{renderState.components.length}</span> : null}
          </button>
        </nav>
      ) : null}

      {isLeader && session ? <LeaderActivityStrip session={session} /> : null}

      {activeTab === "chat" ? (
        <>
          <div className="mob-chat-feed" ref={feedRef}>
            {isLeader ? null : <SessionCallout session={session} />}
            {state.messages.length === 0 && !state.streamingText ? (
              <div className="mob-empty mob-empty--chat">
                <h2>Ready</h2>
                <p>No messages yet.</p>
              </div>
            ) : null}
            {state.messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            {state.streamingText ? (
              <article
                className="mob-message mob-message--assistant mob-message--streaming"
                data-tone="assistant"
                aria-live="polite"
              >
                <div className="mob-message-label">
                  <span>assistant</span>
                  <span className="mob-stream-dots" aria-hidden="true" />
                </div>
                <div className="mob-message-content">{state.streamingText}</div>
              </article>
            ) : null}
          </div>

          <form
            className="mob-composer"
            data-focused={composerFocused ? "true" : "false"}
            data-can-send={canSend ? "true" : "false"}
            data-has-attachments={attachments.length + textAttachments.length > 0 ? "true" : "false"}
            onSubmit={handleSubmit}
          >
            <label className="mob-composer-label" htmlFor="mob-composer-input">
              Message
            </label>
            {attachments.length + textAttachments.length > 0 ? (
              <div className="mob-composer-attachments" aria-label="Attached files">
                {attachments.map((attachment, index) => (
                  <span className="mob-attachment-chip mob-attachment-chip--image" key={`${attachment.filename ?? "image"}-${index}`}>
                    <img
                      src={`data:${attachment.mediaType};base64,${attachment.data}`}
                      alt={attachment.filename ?? `Attachment ${index + 1}`}
                    />
                    <button
                      type="button"
                      onClick={() => removeAttachment(index)}
                      aria-label={`Remove ${attachment.filename ?? `attachment ${index + 1}`}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
                {textAttachments.map((attachment, index) => (
                  <span className="mob-attachment-chip mob-attachment-chip--text" key={`${attachment.filename}-${index}`}>
                    <span className="mob-attachment-file-icon" aria-hidden="true">TXT</span>
                    <span className="mob-attachment-file-name">{attachment.filename}</span>
                    <button
                      type="button"
                      onClick={() => removeTextAttachment(index)}
                      aria-label={`Remove ${attachment.filename}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            {attachmentError ? <div className="mob-composer-error">{attachmentError}</div> : null}
            {promptLength > 0 || attachments.length + textAttachments.length > 0 ? (
              <div className="mob-composer-meta" aria-live="polite">
                {promptLength > 0 ? <span>{promptLength} chars</span> : null}
                {attachments.length > 0 ? (
                  <span>{attachments.length} {attachments.length === 1 ? "image" : "images"}</span>
                ) : null}
                {textAttachments.length > 0 ? (
                  <span>{textAttachments.length} {textAttachments.length === 1 ? "file" : "files"}</span>
                ) : null}
              </div>
            ) : null}
            <input
              ref={fileInputRef}
              className="mob-file-input"
              type="file"
              accept={`image/*,${TEXT_ATTACHMENT_ACCEPT}`}
              multiple
              onChange={handleAttachChange}
              aria-label="File attachments"
            />
            <button
              className="mob-attach-button"
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach file"
            >
              +
            </button>
            <textarea
              id="mob-composer-input"
              value={prompt}
              onChange={(event) => setPrompt(event.currentTarget.value)}
              onFocus={() => setComposerFocused(true)}
              onBlur={() => setComposerFocused(false)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Steer this session"
              rows={2}
            />
            <button className="mob-send-button" type="submit" disabled={!canSend}>
              Send
            </button>
          </form>
        </>
      ) : null}

      {activeTab === "plan" ? (
        <PlanMinionPanel tasks={taskPlan} minions={activeMinions} />
      ) : null}

      {activeTab === "dashboard" ? (
        <MobileDashboardPanel renderState={renderState} sessionKey={sessionKey} send={send} />
      ) : null}
    </main>
  );
}
