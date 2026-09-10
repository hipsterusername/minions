import { AgentMessageText } from "./AgentMessageText.tsx";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { DisplayMessage } from "../sdk-messages.ts";
import { MessageTimestamp } from "./MessageTimestamp.tsx";
import {
  groupMessages,
  isHiddenTool,
  toolDisplayInfo,
  type LeaderMessageGroup,
} from "../nodes/leader-message-helpers.ts";
import "./session-transcript.css";

/** Navigation metadata, never an agent or system message. */
export interface TranscriptBoundary {
  kind: "run-boundary";
  id: string;
  label: string;
  content: string;
  onInspect?: () => void;
}

export type TranscriptEntry = DisplayMessage | TranscriptBoundary;

function groupTranscript(entries: TranscriptEntry[]): (LeaderMessageGroup | TranscriptBoundary)[] {
  const groups: (LeaderMessageGroup | TranscriptBoundary)[] = [];
  let messages: DisplayMessage[] = [];
  for (const entry of entries) {
    if ("kind" in entry) {
      groups.push(...groupMessages(messages), entry);
      messages = [];
    } else {
      messages.push(entry);
    }
  }
  groups.push(...groupMessages(messages));
  return groups;
}

/**
 * Read-only conversation transcript for the Activity inspector.
 *
 * Reuses the same shared, tested grouping the canvas cockpit uses
 * (`groupMessages` + `isHiddenTool`/`shortToolName`): consecutive tool calls
 * collapse into one expandable chip, consecutive thinking blocks collapse into
 * a muted note, and substantive prose renders as role-tagged bubbles. There is
 * no composer here — sending a message is what the fullscreen cockpit is for;
 * this surface is a glanceable preview.
 */

function roleLabel(role: DisplayMessage["role"]): string {
  switch (role) {
    case "user":
      return "You";
    case "assistant":
      return "Agent";
    case "result":
      return "Result";
    case "system":
      return "System";
    default:
      return role;
  }
}

function ToolChip({ msgs }: { msgs: DisplayMessage[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = msgs.filter((m) => !isHiddenTool(m.toolName));
  if (visible.length === 0) return null;
  const infos = visible.map((m) => toolDisplayInfo(m.toolName, m.toolInput));
  const names = infos.map((info) => info.shortLabel);
  const unique = Array.from(new Set(names));
  const head = unique.slice(0, 4).join(", ");
  const overflow = unique.length > 4 ? ` +${unique.length - 4}` : "";
  const primary = infos[0] ?? toolDisplayInfo("tool");

  return (
    <div className="act-tx-toolchip" data-kind={primary.kind}>
      <button
        type="button"
        className="act-tx-toolchip-btn"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={`${visible.length} tool call${visible.length !== 1 ? "s" : ""}: ${head}${overflow}`}
      >
        <span className={`act-tx-chevron${expanded ? " act-tx-chevron--open" : ""}`} aria-hidden="true">
          ▸
        </span>
        <span className="act-tx-toolchip-icon" aria-hidden="true">{primary.icon}</span>
        <span className="act-tx-toolchip-summary">
          {head}
          {overflow}
        </span>
        <span className="act-tx-toolchip-count">{visible.length}</span>
      </button>
      {expanded && (
        <ul className="act-tx-toollist">
          {visible.map((m, i) => {
            const info = toolDisplayInfo(m.toolName, m.toolInput);
            return (
              <li key={`${m.id}-${i}`} className="act-tx-toollist-item">
                <span className="act-tx-toollist-label">{info.label}</span>
                {info.summary ? <span className="act-tx-toollist-summary">{info.summary}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function SessionTranscript({
  messages,
  streamingText,
  thinking = false,
}: {
  messages: TranscriptEntry[];
  streamingText: string;
  thinking?: boolean | undefined;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);
  const anchorScope = useId();
  const anchorId = (boundary: TranscriptBoundary) => `${anchorScope}-${boundary.id}`;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = () => {
      wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };
    el.addEventListener("scroll", handler, { passive: true });
    return () => el.removeEventListener("scroll", handler);
  }, []);

  useEffect(() => {
    if (wasAtBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, streamingText, thinking]);

  const groups = useMemo(() => groupTranscript(messages), [messages]);
  const boundaries = groups.filter((group) => group.kind === "run-boundary");
  const hasContent = groups.length > 0 || streamingText.length > 0 || thinking;

  return (
    <div className="act-tx" ref={scrollRef}>
      {!hasContent && <div className="act-tx-empty">No messages yet.</div>}
      {groups.map((group, i) => {
        if (group.kind === "run-boundary") {
          const index = boundaries.indexOf(group);
          const previous = boundaries[index - 1];
          const next = boundaries[index + 1];
          const jumpLink = (target: TranscriptBoundary, text: string, label?: string) => (
            <a href={`#${encodeURIComponent(anchorId(target))}`} aria-label={label}
              onClick={() => {
                wasAtBottomRef.current = false;
                document.getElementById(anchorId(target))?.focus({ preventScroll: true });
              }}>{text}</a>
          );
          return (
            <nav key={group.id} id={anchorId(group)} tabIndex={-1}
              className="act-tx-run-boundary" aria-label={`${group.label} navigation`}>
              {jumpLink(group, group.content)}
              <span className="act-tx-run-boundary-line" aria-hidden="true" />
              {group.onInspect && <button type="button" onClick={group.onInspect}
                aria-label={`Inspect ${group.label}`}>Inspect</button>}
              {previous && jumpLink(previous, "↑", `Previous: ${previous.label}`)}
              {next && jumpLink(next, "↓", `Next: ${next.label}`)}
            </nav>
          );
        }
        if (group.kind === "tool-group") {
          return <ToolChip key={`tools-${i}`} msgs={group.msgs} />;
        }
        if (group.kind === "thinking-group") {
          const text = group.msgs.map((m) => m.content).join("\n").trim();
          if (!text) return null;
          return (
            <div key={`think-${i}`} className="act-tx-thinking">
              {text}
            </div>
          );
        }
        const msg = group.msg;
        if (!msg.content.trim() && msg.role !== "result") return null;
        return (
          <div key={msg.id} className={`act-tx-msg act-tx-msg--${msg.role}`}>
            <div className="act-tx-msg-head">
              <span className="act-tx-msg-role">{roleLabel(msg.role)}</span>
              {msg.suffix && <span className="act-tx-msg-suffix">{msg.suffix}</span>}
              <MessageTimestamp
                timestamp={msg.timestamp}
                className="act-tx-msg-time"
              />
            </div>
            <div className="act-tx-msg-body">{msg.role === "assistant" || msg.role === "result" ? <AgentMessageText text={msg.content} /> : msg.content}</div>
          </div>
        );
      })}
      {streamingText && (
        <div className="act-tx-msg act-tx-msg--assistant act-tx-msg--streaming">
          <div className="act-tx-msg-head">
            <span className="act-tx-msg-role">Agent</span>
            <span className="act-tx-msg-dot" aria-hidden="true" />
          </div>
          <div className="act-tx-msg-body"><AgentMessageText text={streamingText} /></div>
        </div>
      )}
      {thinking && !streamingText && (
        <div className="act-tx-msg act-tx-msg--assistant act-tx-msg--streaming"
          role="status" aria-live="polite">
          <div className="act-tx-msg-head">
            <span className="act-tx-msg-role">Agent</span>
            <span className="act-tx-msg-dot" aria-hidden="true" />
          </div>
          <div className="act-tx-msg-body">Leader is thinking…</div>
        </div>
      )}
    </div>
  );
}
