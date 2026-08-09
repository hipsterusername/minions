import {
  useCallback,
  useEffect,
  useMemo,
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
  StreamingIndicator,
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
import { LeaderPromptBar } from "../prompt/LeaderPromptBar.tsx";
import type { LeaderData, MessageContextSelection } from "../types.ts";
import { ActivityRail } from "./ActivityRail.tsx";
import { ContextDrawer } from "./ContextDrawer.tsx";
import { PaneDivider } from "./PaneDivider.tsx";

const LEFT_PANE_DEFAULT = 260;
const LEFT_PANE_MIN = 180;
const LEFT_PANE_MAX = 480;
const RIGHT_PANE_DEFAULT = 360;
const RIGHT_PANE_MIN = 280;
const RIGHT_PANE_MAX = 560;

/**
 * Leader fullscreen mode — a 3-pane cockpit portaled to document.body.
 *
 * Pattern matches `MarkdownNode`'s focus mode: portaled overlay (escapes
 * the canvas CSS transform stack), body-scroll lock, and Esc to exit.
 * Toggle + Cmd/Ctrl+Shift+F handling live in `LeaderNode.tsx` since the
 * focus-scope check needs the node root ref.
 *
 * The overlay is a presentation component: all state, callbacks, and
 * derived values arrive as props from the renderer. Both views read from
 * the same `LeaderData` so the in-canvas stub and the overlay stay in
 * sync automatically.
 */

export interface LeaderFullscreenProps {
  data: LeaderData;
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

  /* Slot: chrome to mount inside the overlay so the existing
     SessionToolbar / StatusBannerStack render at the top of the chat
     pane without LeaderFullscreen having to know how to build them. */
  toolbarSlot: ReactNode;
  bannerSlot: ReactNode;
}

const STATUS_COLOR: Record<LeaderData["status"], string> = {
  disconnected: "var(--text-muted)",
  creating: "var(--status-creating)",
  running: "var(--status-success)",
  idle: "var(--text-muted)",
  stopped: "var(--text-muted)",
  error: "var(--status-error)",
  completed: "var(--success-color)",
};

export function LeaderFullscreen(props: LeaderFullscreenProps) {
  const {
    data,
    onUpdateData,
    onExit,
    input,
    onInputChange,
    onPromptSubmit,
    onPromptKeyDown,
    promptPlaceholder,
    promptSubmitLabel,
    promptSubmitDisabled,
    promptSubmitActive,
    onStop,
    messageContextSelection,
    activateMessageSelection,
    setMessageContextSelection,
    exitMessageSelection,
    onAddContentNode,
    onRevealMinion,
    onOpenSkillFlyout,
    skillFlyoutAnchorRef,
    toolbarSlot,
    bannerSlot,
  } = props;

  // Body-scroll lock: prevent stray wheel events from panning the canvas
  // underneath the overlay. Same rationale as MarkdownNode focus mode.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // ── Auto-scroll + "jump to latest" pill ─────────────────────────
  // Pin scroll to bottom UNTIL the user scrolls up. Once they're 80px+
  // away from the bottom we stop auto-scrolling and show a pill that
  // jumps them back. This mirrors how ChatGPT / Slack behave so a long
  // reply doesn't yank the user out of whatever they're reading.
  const outputRef = useRef<HTMLDivElement | null>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = outputRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    setPinnedToBottom(true);
  }, []);

  const handleScroll = useCallback(() => {
    const el = outputRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinnedToBottom(distance < 80);
  }, []);

  useEffect(() => {
    if (pinnedToBottom && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [data.messages.length, data.streamingText, pinnedToBottom]);

  // ── Drag-resizable pane widths ──────────────────────────────────
  const [leftWidth, setLeftWidth] = useState(LEFT_PANE_DEFAULT);
  const [rightWidth, setRightWidth] = useState(RIGHT_PANE_DEFAULT);
  const handleLeftResize = useCallback((delta: number) => {
    setLeftWidth((w) =>
      Math.max(LEFT_PANE_MIN, Math.min(LEFT_PANE_MAX, w + delta)),
    );
  }, []);
  const handleRightResize = useCallback((delta: number) => {
    setRightWidth((w) =>
      Math.max(RIGHT_PANE_MIN, Math.min(RIGHT_PANE_MAX, w + delta)),
    );
  }, []);

  const groupedMessages = useMemo(
    () => groupMessages(data.messages),
    [data.messages],
  );

  const thinkingEffort =
    data.thinkingConfig?.effort ?? DEFAULT_THINKING_CONFIG.effort;

  const overlay = (
    <div
      className="leader-fullscreen-overlay"
      data-testid="leader-fullscreen-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Leader fullscreen cockpit"
      data-scroll-capture
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9000,
        background: "var(--bg-primary)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 16px",
          background: "var(--bg-surface)",
          borderBottom: "1px solid var(--border-default)",
        }}
      >
        <LeaderStatusIcon
          active={data.status === "running" || data.status === "creating"}
          size={22}
        />
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--text-primary)",
              lineHeight: 1.2,
            }}
          >
            <EditableTitle
              value={data.taskName ?? "Leader"}
              onChange={(name) =>
                onUpdateData({ ...data, taskName: name || null })
              }
            />
          </div>
          <div
            style={{
              fontSize: 10,
              color: STATUS_COLOR[data.status] ?? "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              textTransform: "uppercase",
              letterSpacing: 0.5,
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 2,
            }}
          >
            {data.status}
            {data.turns > 0 && (
              <span
                style={{
                  color: "var(--text-muted)",
                  textTransform: "none",
                }}
              >
                {data.turns} turn{data.turns !== 1 ? "s" : ""}
              </span>
            )}
            {data.totalCost > 0 && (
              <span style={{ color: "var(--text-muted)", textTransform: "none" }}>
                ${data.totalCost.toFixed(4)}
              </span>
            )}
          </div>
        </div>

        <span style={{ flex: 1 }} />

        {data.status === "running" && (
          <button
            onClick={onStop}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              padding: "5px 14px",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              fontWeight: 600,
              background: "var(--danger-bg)",
              border: "1px solid var(--danger-color)",
              borderRadius: 4,
              color: "var(--status-error)",
              cursor: "pointer",
            }}
          >
            Stop
          </button>
        )}

        <button
          onClick={onExit}
          onMouseDown={(e) => e.stopPropagation()}
          aria-label="Exit fullscreen"
          aria-pressed="true"
          title="Exit fullscreen (Esc)"
          data-testid="leader-fullscreen-exit"
          style={{
            padding: "5px 12px",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            fontWeight: 600,
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-default)",
            borderRadius: 4,
            color: "var(--text-secondary)",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden
          >
            <path d="M7 2v4H3v1.5h5.5V2H7zM2 8.5V10h4v4h1.5V8.5H2zm12.5 0H9V14h1.5v-4h4V8.5zM14.5 7v-.5H10V2H8.5v5.5h6V7z" />
          </svg>
          Exit
        </button>
      </header>

      {/* ── 3-pane body (drag-resizable) ─────────────────────────
          Plain flex layout (not grid) so the dividers' inline width
          updates take effect without a layout-engine round trip. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "row",
        }}
      >
        <div
          style={{
            width: leftWidth,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
          }}
        >
          <ActivityRail data={data} onRevealMinion={onRevealMinion} />
        </div>

        <PaneDivider
          side="left"
          onResize={handleLeftResize}
          onReset={() => setLeftWidth(LEFT_PANE_DEFAULT)}
          ariaLabel="Resize activity rail"
        />

        <section
          data-testid="leader-fullscreen-conversation"
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            background: "var(--bg-primary)",
            minWidth: 0,
            minHeight: 0,
            position: "relative",
          }}
        >
          {toolbarSlot}
          {bannerSlot}

          <div
            ref={outputRef}
            data-scroll-capture
            onMouseDown={(e) => e.stopPropagation()}
            onScroll={handleScroll}
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              padding: "16px clamp(16px, 6vw, 64px)",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {data.messages.length === 0 && (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-muted)",
                  fontSize: 13,
                }}
              >
                {data.sessionKey
                  ? "Leader is thinking..."
                  : "Describe your project goal to begin orchestration"}
              </div>
            )}
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
            ) : data.status === "running" && data.messages.length > 0 ? (
              <StreamingIndicator label="Leader is thinking..." />
            ) : null}
            {data.waitUntil && data.waitUntil > Date.now() && (
              <WaitCountdown
                waitUntil={data.waitUntil}
                reason={data.waitReason ?? "Waiting..."}
              />
            )}
          </div>

          {/* Jump-to-latest pill — shown only when the user has scrolled
              up far enough that we stopped pinning to the bottom. */}
          {!pinnedToBottom && (
            <button
              type="button"
              onClick={() => scrollToBottom("smooth")}
              onMouseDown={(e) => e.stopPropagation()}
              data-testid="leader-fullscreen-scroll-pill"
              aria-label="Jump to latest message"
              style={{
                position: "absolute",
                bottom: 92,
                left: "50%",
                transform: "translateX(-50%)",
                padding: "5px 12px",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                fontWeight: 600,
                background: "var(--bg-elevated)",
                border: "1px solid var(--accent)",
                borderRadius: 999,
                color: "var(--accent)",
                cursor: "pointer",
                boxShadow: "var(--shadow-lg)",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                zIndex: 5,
              }}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden
              >
                <path d="M8 12l-5-5h10z" />
              </svg>
              Jump to latest
            </button>
          )}

          <LeaderPromptBar
            input={input}
            onInputChange={onInputChange}
            onKeyDown={onPromptKeyDown}
            onSubmit={onPromptSubmit}
            placeholder={promptPlaceholder}
            submitLabel={promptSubmitLabel}
            disabled={promptSubmitDisabled}
            active={promptSubmitActive}
          />

          {data.error && (
            <div
              style={{
                padding: "8px 16px",
                background: "var(--danger-bg)",
                color: "var(--status-error)",
                fontSize: 11,
                borderTop: "1px solid var(--danger-color)",
                fontFamily: "var(--font-mono)",
                wordBreak: "break-word",
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <span style={{ flex: 1 }}>{data.error}</span>
              <CopyButton
                text={data.fullError ?? data.error}
                layout="inline"
                alwaysVisible
                title="Copy error to clipboard"
              />
              <button
                onClick={() => onUpdateData({ ...data, error: null })}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--status-error)",
                  cursor: "pointer",
                  fontSize: 14,
                  padding: "0 2px",
                  lineHeight: 1,
                  flexShrink: 0,
                  opacity: 0.7,
                }}
                title="Dismiss error"
                aria-label="Dismiss error"
              >
                x
              </button>
            </div>
          )}
        </section>

        <PaneDivider
          side="right"
          onResize={handleRightResize}
          onReset={() => setRightWidth(RIGHT_PANE_DEFAULT)}
          ariaLabel="Resize context drawer"
        />

        <div
          style={{
            width: rightWidth,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
          }}
        >
          <ContextDrawer
            data={data}
            onUpdateData={onUpdateData}
            skillFlyoutAnchorRef={skillFlyoutAnchorRef}
            onOpenSkillFlyout={onOpenSkillFlyout}
          />
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
