import {
  useLayoutEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { SimpleMarkdown } from "../../../components/SimpleMarkdown.tsx";
import type { LeaderData, LeaderMessage } from "../types.ts";
import { LeaderPromptBar } from "./LeaderPromptBar.tsx";

/**
 * Full-screen prompt overlay used when the leader card is zoomed out
 * past `LEADER_PROMPT_OVERLAY_ZOOM_THRESHOLD`. Shows the most recent
 * conversation context (last few messages + active streaming text) above
 * a large {@link LeaderPromptBar} so the user can keep prompting without
 * needing to zoom back in.
 *
 * Portaled to `document.body` to escape canvas transforms.
 *
 * Extracted from `src/nodes/LeaderNode.tsx` (Phase 8 of the leader refactor).
 */
export function LeaderPromptOverlay({
  open,
  input,
  title,
  messages,
  streamingText,
  status,
  onClose,
  onInputChange,
  onKeyDown,
  onSubmit,
  placeholder,
  submitLabel,
  disabled,
  active,
}: {
  open: boolean;
  input: string;
  title: string;
  messages: LeaderMessage[];
  streamingText: string;
  status: LeaderData["status"];
  onClose: () => void;
  onInputChange: (value: string) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onSubmit: () => void;
  placeholder: string;
  submitLabel: string;
  disabled: boolean;
  active: boolean;
}) {
  const overlayInputRef = useRef<HTMLTextAreaElement | null>(null);
  const contextRef = useRef<HTMLDivElement | null>(null);
  const didInitialContextScrollRef = useRef(false);
  const contextMessages = useMemo(() => {
    const chatRoles = new Set<LeaderMessage["role"]>([
      "user",
      "assistant",
      "result",
      "system",
    ]);
    const visible = messages
      .filter((msg) => chatRoles.has(msg.role) && msg.content.trim().length > 0)
      .slice(-6);

    if (streamingText.trim()) {
      visible.push({
        id: "leader-prompt-overlay-streaming",
        role: "assistant",
        content: streamingText.replace(/<!--task-name:.+?-->\s*/g, ""),
        timestamp: Date.now(),
      });
    }

    return visible;
  }, [messages, streamingText]);

  useLayoutEffect(() => {
    if (!open) {
      didInitialContextScrollRef.current = false;
      return;
    }
    if (didInitialContextScrollRef.current) return;
    const contextEl = contextRef.current;
    if (!contextEl) return;
    contextEl.scrollTop = contextEl.scrollHeight;
    didInitialContextScrollRef.current = true;
  }, [open, contextMessages.length]);

  if (!open) return null;

  return createPortal(
    <>
      <div
        data-testid="leader-prompt-overlay-backdrop"
        onMouseDown={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 9990,
          background: "rgba(0, 0, 0, 0.16)",
        }}
      />
      <div
        data-testid="leader-prompt-overlay"
        data-no-drag
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: "fixed",
          left: "50%",
          bottom: 24,
          transform: "translateX(-50%)",
          zIndex: 9991,
          width: "min(760px, calc(100vw - 32px))",
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-hover)",
          borderRadius: 8,
          boxShadow: "var(--shadow-lg)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            minHeight: 34,
            padding: "8px 12px 0",
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
          }}
        >
          <img
            src={
              status === "running" || status === "creating"
                ? "/icons/leader-active.svg"
                : "/icons/leader-idle.svg"
            }
            alt={
              status === "running" || status === "creating" ? "Active" : "Idle"
            }
            width={18}
            height={18}
            className="leader-status-icon"
            style={{ display: "block", flexShrink: 0 }}
          />
          <span
            title={title}
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--text-primary)",
              fontWeight: 700,
            }}
          >
            {title}
          </span>
          <button
            type="button"
            onClick={onClose}
            onMouseDown={(e) => e.stopPropagation()}
            aria-label="Close enlarged prompt"
            title="Close enlarged prompt"
            style={{
              width: 24,
              height: 24,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
              background: "var(--bg-elevated)",
              color: "var(--text-muted)",
              cursor: "pointer",
              padding: 0,
              fontSize: 14,
              lineHeight: 1,
            }}
          >
            x
          </button>
        </div>
        {contextMessages.length > 0 && (
          <div
            ref={contextRef}
            data-testid="leader-prompt-context"
            data-scroll-capture
            style={{
              margin: "8px 10px 0",
              maxHeight: "min(360px, 42vh)",
              overflowY: "auto",
              padding: "8px",
              display: "flex",
              flexDirection: "column",
              gap: 6,
              background: "var(--bg-surface)",
              border: "1px solid var(--border-default)",
              borderRadius: 6,
            }}
          >
            {contextMessages.map((msg) => {
              const role = msg.role === "result" ? "assistant" : msg.role;
              const text =
                msg.content.length > 1400
                  ? `${msg.content.slice(0, 1397)}...`
                  : msg.content;
              return (
                <div
                  key={msg.id}
                  style={{
                    padding: "7px 9px",
                    borderRadius: 6,
                    background:
                      role === "user"
                        ? "var(--state-active)"
                        : "var(--bg-primary)",
                    border: "1px solid var(--border-default)",
                    color: "var(--text-secondary)",
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}
                >
                  <div
                    style={{
                      marginBottom: 4,
                      color:
                        role === "user" ? "var(--accent)" : "var(--text-muted)",
                      fontFamily: "var(--font-mono)",
                      fontSize: 9,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                    }}
                  >
                    {role}
                  </div>
                  <SimpleMarkdown text={text} />
                </div>
              );
            })}
          </div>
        )}
        <LeaderPromptBar
          input={input}
          onInputChange={onInputChange}
          onKeyDown={onKeyDown}
          onSubmit={onSubmit}
          placeholder={placeholder}
          submitLabel={submitLabel}
          disabled={disabled}
          active={active}
          variant="overlay"
          autoFocus
          textareaRef={overlayInputRef}
        />
      </div>
    </>,
    document.body,
  );
}
