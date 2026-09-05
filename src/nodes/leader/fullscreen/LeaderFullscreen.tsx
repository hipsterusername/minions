import {
  useCallback,
  useEffect,
  useMemo,
  type CSSProperties,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { chatRoleStyle } from "../../../chat-bubble-style.ts";
import { CopyButton } from "../../../components/CopyButton.tsx";
import {
  StreamingBubble,
} from "../../../components/StreamingBubble.tsx";
import { DEFAULT_THINKING_CONFIG } from "../../../types.ts";
import { groupMessages } from "../../leader-message-helpers.ts";
import { EditableTitle } from "../EditableTitle.tsx";
import { LeaderStatusIcon } from "../LeaderStatusIcon.tsx";
import { WaitCountdown } from "../WaitCountdown.tsx";
import { LeaderToolGroup } from "../messages/ToolItem.tsx";
import { LeaderThinkingGroup } from "../messages/ThinkingGroup.tsx";
import { UserMessageBubble } from "../messages/UserMessageBubble.tsx";
import { SelectableMessageBubble } from "../messages/SelectableMessageBubble.tsx";
import { LeaderWorkingIndicator } from "../messages/LeaderWorkingIndicator.tsx";
import { LeaderPromptBar } from "../prompt/LeaderPromptBar.tsx";
import type { LeaderData, MessageContextSelection } from "../types.ts";
import { ActivityRail } from "./ActivityRail.tsx";
import { ContextDrawer } from "./ContextDrawer.tsx";
import { PaneDivider } from "./PaneDivider.tsx";

import { LayoutDashboard, MessageSquare, PanelLeft, PanelRight, ArrowLeft, Square, Bot } from "lucide-react";
import type { ContextItem } from "../../../types.ts";
import { formatCanvasWorkItemStatus, selectCanvasChangeMode } from "../work-item.ts";
import { partitionDashboardQuestions } from "../../render/dashboard-questions.ts";
import "./leader-fullscreen.css";

export interface LeaderFullscreenProps {
  data: LeaderData;
  isWorking: boolean;
  onUpdateData: (next: LeaderData) => void;
  onExit: () => void;

  /* Chat composer */
  input: string;
  onInputChange: (v: string) => void;
  onPromptSubmit: () => void;
  onPromptKeyDown: (e: KeyboardEvent) => void;
  promptPlaceholder: string;
  promptSubmitLabel: string;
  promptSubmitDisabled: boolean;
  promptSubmitActive: boolean;

  /* Header actions */
  onStop: () => void;

  /* Messages — same selection state as the in-canvas view */
  messageContextSelection: MessageContextSelection | null;
  activateMessageSelection: (id: string) => void;
  setMessageContextSelection: (sel: MessageContextSelection) => void;
  exitMessageSelection: () => void;
  onAddContentNode?: ((content: string) => void) | undefined;

  /* Task plan — reveal-in-canvas action */
  onRevealMinion?: ((minionSessionKey: string) => void) | undefined;

  /* Skill flyout — opens the existing portaled flyout in the renderer */
  onOpenSkillFlyout: () => void;
  /** Anchor element for the skill flyout's positioning. */
  skillFlyoutAnchorRef: RefObject<HTMLElement | null>;
  graphProjection?: { title: string; status: string; detail: string } | null;
  onOpenGraph?: (() => void) | undefined;

  /* Slot: chrome to mount inside the overlay so the existing
     SessionToolbar / StatusBannerStack render at the top of the chat
     pane without LeaderFullscreen having to know how to build them. */
  dashboardSlot?: ReactNode;
  minionsSlot?: ReactNode;
  configSlot?: ReactNode;
  actionsSlot?: ReactNode;
  contextItems?: ContextItem[] | undefined;
  toolbarSlot: ReactNode;
  bannerSlot: ReactNode;
}

export function LeaderFullscreen(props: LeaderFullscreenProps) {
  const { data, isWorking, onUpdateData, onExit, input, onInputChange,
    onPromptSubmit, onPromptKeyDown, promptPlaceholder, promptSubmitLabel,
    promptSubmitDisabled, promptSubmitActive, onStop, messageContextSelection,
    activateMessageSelection, setMessageContextSelection, exitMessageSelection,
    onAddContentNode, onRevealMinion, onOpenSkillFlyout, skillFlyoutAnchorRef,
    graphProjection, onOpenGraph, toolbarSlot, bannerSlot, dashboardSlot,
    minionsSlot, configSlot, actionsSlot, contextItems } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const [reviewRequest, setReviewRequest] = useState(0);
  const [view, setView] = useState<"conversation" | "dashboard" | "minions">("conversation");
  const [side, setSide] = useState<"activity" | "context" | null>(null);
  const [leftHidden, setLeftHidden] = useState(false);
  const [rightHidden, setRightHidden] = useState(false);
  const [leftWidth, setLeftWidth] = useState(250);
  const [rightWidth, setRightWidth] = useState(330);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const groupedMessages = useMemo(() => groupMessages(data.messages), [data.messages]);
  const thinkingEffort = data.thinkingConfig?.effort ?? DEFAULT_THINKING_CONFIG.effort;
  const questionCount = partitionDashboardQuestions(data.renderState?.components ?? [], new Map()).questions.length;
  const hasDashboard = Boolean(data.renderState?.components.length);
  const minionCount = data.taskPlan.filter(t => t.executor === "minion").length;
  const selectedView = view === "dashboard" && !hasDashboard ? "conversation"
    : view === "minions" && !minionsSlot ? "conversation" : view;
  const approvalPending = selectCanvasChangeMode(data) === "worktree" && data.approvalPending;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    rootRef.current?.querySelector<HTMLButtonElement>('[data-testid="leader-fullscreen-exit"]')?.focus();
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    if (pinnedToBottom && outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [data.messages.length, data.streamingText, pinnedToBottom, selectedView]);

  const scrollToBottom = useCallback(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight, behavior: "smooth" });
    setPinnedToBottom(true);
  }, []);
  const revealMinion = (key: string) => {
    onRevealMinion?.(key);
    if (minionsSlot) { setView("minions"); setSide(null); }
  };
  const toggleSide = (next: "activity" | "context") => {
    setSide(side === next ? null : next);
    if (next === "activity") setLeftHidden(!leftHidden);
    else setRightHidden(!rightHidden);
  };
  const trapFocus = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const elements = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input, textarea, select, [tabindex="0"]',
    )).filter(el => el.getClientRects().length > 0 && !el.closest('[hidden]'));
    const first = elements[0], last = elements.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  };

  return createPortal(
    <div ref={rootRef} className="leader-fullscreen-overlay" data-testid="leader-fullscreen-overlay"
      role="dialog" aria-modal="true" aria-label="Leader fullscreen cockpit" data-scroll-capture
      onKeyDown={trapFocus} onPointerDown={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
      <header className="leader-fs-header">
        <button className="leader-fs-button" onClick={onExit} aria-label="Exit fullscreen"
          aria-pressed="true" title="Back to canvas (Esc)" data-testid="leader-fullscreen-exit">
          <ArrowLeft size={15} aria-hidden="true" /><span>Canvas</span>
        </button>
        <span className="leader-fs-header-divider" />
        <LeaderStatusIcon active={isWorking || data.status === "creating"} size={24} />
        <div className="leader-fs-identity">
          <EditableTitle value={data.taskName ?? "Leader"} onChange={name => onUpdateData({ ...data, taskName: name || null })} />
          <div className="leader-fs-subtitle">
            <span className="leader-fs-status" data-active={isWorking}>{formatCanvasWorkItemStatus(data.workItemSnapshot, data.liveEditAwareness) ?? data.status}</span>
            <span>{data.harness ?? "claude"} · {data.model}</span>
          </div>
        </div>
        <div className="leader-fs-session-cost" title="Reported leader session cost; delegated task costs are listed separately">
          <strong>${data.totalCost.toFixed(3)}</strong><span>{data.turns} turns</span>
        </div>
        {isWorking && <button className="leader-fs-button leader-fs-button--danger" onClick={onStop}><Square size={12} aria-hidden="true" /> Stop</button>}
        {actionsSlot}
      </header>
      <div className="leader-fs-body" data-side={side ?? "none"} data-left-hidden={leftHidden}
        data-right-hidden={rightHidden} style={{ "--activity-width": `${leftWidth}px`, "--context-width": `${rightWidth}px` } as CSSProperties}>
        <div className="leader-fs-activity" id="leader-fs-activity">
          <div className="leader-fs-pane-heading"><span>Execution</span><button className="leader-fs-icon" aria-label="Close execution panel" onClick={() => { setSide(null); setLeftHidden(true); }}>×</button></div>
          {graphProjection && <div className="leader-fs-graph-summary"><span className="leader-fs-muted">Execution graph · {graphProjection.status}</span><strong>{graphProjection.title}</strong><span>{graphProjection.detail}</span><button className="leader-fs-button" onClick={onOpenGraph} disabled={!onOpenGraph}>Inspect graph →</button></div>}
          <ActivityRail data={data} onRevealMinion={revealMinion} />
        </div>
        <div className="leader-fs-divider leader-fs-divider--left"><PaneDivider value={leftWidth} min={200} max={360} side="left" onResize={d => setLeftWidth(w => Math.min(360, Math.max(200, w + d)))} onReset={() => setLeftWidth(250)} ariaLabel="Resize activity rail" /></div>
        <main className="leader-fs-main">
          <div className="leader-fs-workspace-nav">
            <button className="leader-fs-icon" aria-label="Toggle execution panel" aria-controls="leader-fs-activity" onClick={() => toggleSide("activity")}><PanelLeft size={16} /></button>
            <nav aria-label="Leader workspace" className="leader-fs-view-tabs">
              <button className="leader-fs-view-tab" aria-current={selectedView === "conversation" ? "page" : undefined} onClick={() => setView("conversation")}><MessageSquare size={14} />Conversation</button>
              <button className="leader-fs-view-tab" aria-current={selectedView === "dashboard" ? "page" : undefined} disabled={!hasDashboard} title={hasDashboard ? "Open leader dashboard and decisions" : "Dashboard appears when the leader shares an artifact or question"} onClick={() => { setView("dashboard"); setSide(null); }}><LayoutDashboard size={14} />Dashboard{hasDashboard && <span className="leader-fs-dot" />}</button>
              {minionsSlot && <button className="leader-fs-view-tab" aria-current={selectedView === "minions" ? "page" : undefined} onClick={() => { setView("minions"); setSide(null); }}><Bot size={14} />Minions <span>{minionCount}</span></button>}
            </nav>
            <button className="leader-fs-icon" aria-label="Toggle context panel" aria-controls="leader-fs-context" onClick={() => toggleSide("context")}><PanelRight size={16} />{approvalPending && <span className="leader-fs-dot" />}</button>
          </div>
          {bannerSlot}
          {questionCount > 0 && selectedView !== "dashboard" && <button className="leader-fs-attention" onClick={() => { setView("dashboard"); setSide(null); }}>{questionCount} {questionCount === 1 ? "question needs" : "questions need"} your response. Open dashboard →</button>}
          {approvalPending && <button className="leader-fs-attention" onClick={() => { setSide("context"); setRightHidden(false); setReviewRequest(n => n + 1); }}>Changes are ready for review. Open review & settings →</button>}
          <section className="leader-fs-conversation" data-testid="leader-fullscreen-conversation" hidden={selectedView !== "conversation"}>
            <div className="leader-fs-runtime">{toolbarSlot}</div>
            <div ref={outputRef} className="leader-fs-messages" data-scroll-capture onMouseDown={e => e.stopPropagation()}
              onScroll={() => { const el = outputRef.current; if (el) setPinnedToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80); }}>
              {data.messages.length === 0 && !isWorking && !data.streamingText && <div className="leader-fs-empty"><MessageSquare size={28} strokeWidth={1.3} /><h2>{data.sessionKey ? "Continue the conversation" : "What would you like to accomplish?"}</h2><p>{data.sessionKey ? "Send a message to steer the next step." : "Describe your goal. Your leader can investigate, build, delegate work, and bring decisions back to you."}</p><span>Use / for commands · Inspect connected sources in Context</span></div>}
            {groupedMessages.map((group, gi) => {
              if (group.kind === "tool-group") {
                return <LeaderToolGroup key={`tg-${gi}`} msgs={group.msgs} />;
              }
              if (group.kind === "thinking-group") {
                return (
                  <LeaderThinkingGroup
                    key={`thg-${gi}`}
                    msgs={group.msgs}
                    effort={thinkingEffort}
                  />
                );
              }
              const msg = group.msg;
              if (msg.role === "user") {
                return <UserMessageBubble key={msg.id} msg={msg} />;
              }
              if (msg.role === "thinking") {
                return (
                  <LeaderThinkingGroup
                    key={msg.id}
                    msgs={[msg]}
                    effort={thinkingEffort}
                  />
                );
              }
              if (msg.role === "assistant" || msg.role === "result") {
                return (
                  <SelectableMessageBubble
                    key={msg.id}
                    msg={msg}
                    selection={messageContextSelection}
                    onActivate={activateMessageSelection}
                    onSelectionChange={setMessageContextSelection}
                    onExit={exitMessageSelection}
                    onAddContentNode={onAddContentNode}
                  />
                );
              }
              return (
                <div key={msg.id} style={chatRoleStyle("system")}>
                  {msg.content}
                </div>
              );
            })}
            {data.streamingText ? (
              <StreamingBubble
                text={data.streamingText.replace(
                  /<!--task-name:.+?-->\s*/g,
                  "",
                )}
                role="assistant"
              />
            ) : null}
            {isWorking && <LeaderWorkingIndicator />}
            {data.waitUntil && data.waitUntil > Date.now() && (
              <WaitCountdown
                waitUntil={data.waitUntil}
                reason={data.waitReason ?? "Waiting..."}
              />
            )}

            </div>
            {!pinnedToBottom && <button className="leader-fs-latest leader-fs-button" onClick={scrollToBottom}>↓ Jump to latest</button>}
            <LeaderPromptBar input={input} onInputChange={onInputChange} onKeyDown={onPromptKeyDown} onSubmit={onPromptSubmit}
              placeholder={promptPlaceholder} submitLabel={promptSubmitLabel} disabled={promptSubmitDisabled} active={promptSubmitActive} />
          </section>
          {hasDashboard && <section hidden={selectedView !== "dashboard"} className="leader-fs-surface" aria-label="Leader dashboard">{dashboardSlot}</section>}
          {minionsSlot && <section hidden={selectedView !== "minions"} className="leader-fs-surface" aria-label="Minion workspace">{minionsSlot}</section>}
          {data.error && <div className="leader-fs-error" role="alert"><span>{data.error}</span><CopyButton text={data.fullError ?? data.error} layout="inline" alwaysVisible /><button className="leader-fs-icon" aria-label="Dismiss error" onClick={() => onUpdateData({ ...data, error: null })}>×</button></div>}
        </main>
        <div className="leader-fs-divider leader-fs-divider--right"><PaneDivider value={rightWidth} min={280} max={440} side="right" onResize={d => setRightWidth(w => Math.min(440, Math.max(280, w + d)))} onReset={() => setRightWidth(330)} ariaLabel="Resize context drawer" /></div>
        <div className="leader-fs-context" id="leader-fs-context">
          <div className="leader-fs-pane-heading"><span>Context & controls</span><button className="leader-fs-icon" aria-label="Close context panel" onClick={() => { setSide(null); setRightHidden(true); }}>×</button></div>
          <ContextDrawer data={data} onUpdateData={onUpdateData} skillFlyoutAnchorRef={skillFlyoutAnchorRef}
            onOpenSkillFlyout={onOpenSkillFlyout} graphProjection={graphProjection} onOpenGraph={onOpenGraph}
            configSlot={configSlot} contextItems={contextItems} reviewRequest={reviewRequest} />
        </div>
      </div>
    </div>, document.body,
  );
}
