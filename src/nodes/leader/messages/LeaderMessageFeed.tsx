/**
 * LeaderMessageFeed — the scrollable conversation feed for the Leader node.
 *
 * Extracted from `LeaderNode.tsx` so the chat feed can be composed into the
 * responsive `LeaderBody` (split-pane / tabbed) without bloating the leader
 * renderer. Purely presentational: it renders grouped messages, the streaming
 * preview, the optional debug inspector, and the wait countdown.
 */

import type { RefObject } from "react";
import { StreamingBubble, StreamingIndicator } from "../../../components/StreamingBubble.tsx";
import { chatRoleStyle } from "../../../chat-bubble-style.ts";
import { DebugInspector } from "../../../components/DebugInspector.tsx";
import { WaitCountdown } from "../WaitCountdown.tsx";
import { LeaderToolGroup } from "./ToolItem.tsx";
import { LeaderThinkingGroup } from "./ThinkingGroup.tsx";
import { UserMessageBubble } from "./UserMessageBubble.tsx";
import { SelectableMessageBubble } from "./SelectableMessageBubble.tsx";
import type { LeaderData, MessageContextSelection } from "../types.ts";
import type { LeaderMessageGroup } from "../../leader-message-helpers.ts";

export interface LeaderMessageFeedProps {
  outputRef: RefObject<HTMLDivElement | null>;
  data: LeaderData;
  groupedMessages: LeaderMessageGroup[];
  messageContextSelection: MessageContextSelection | null;
  onActivateMessageSelection: (messageId: string) => void;
  onMessageSelectionChange: (selection: MessageContextSelection) => void;
  onExitMessageSelection: () => void;
  onAddContentNode?: ((content: string) => void) | undefined;
  debugEnabled: boolean;
}

export function LeaderMessageFeed({
  outputRef,
  data,
  groupedMessages,
  messageContextSelection,
  onActivateMessageSelection,
  onMessageSelectionChange,
  onExitMessageSelection,
  onAddContentNode,
  debugEnabled,
}: LeaderMessageFeedProps) {
  return (
    <div
      ref={outputRef}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "auto",
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
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
            fontSize: 12,
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
              effort={data.thinkingConfig?.effort}
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
              effort={data.thinkingConfig?.effort}
            />
          );
        }

        if (msg.role === "assistant" || msg.role === "result") {
          return (
            <SelectableMessageBubble
              key={msg.id}
              msg={msg}
              selection={messageContextSelection}
              onActivate={onActivateMessageSelection}
              onSelectionChange={onMessageSelectionChange}
              onExit={onExitMessageSelection}
              onAddContentNode={onAddContentNode}
            />
          );
        }

        // System messages — compact
        return (
          <div key={msg.id} style={chatRoleStyle("system")}>
            {msg.content}
            {msg.suffix && (
              <span style={{ display: "inline-block", marginLeft: 6, fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)", opacity: 0.7 }}>
                {msg.suffix}
              </span>
            )}
          </div>
        );
      })}
      {/* Streaming partial text with blinking cursor */}
      {data.streamingText ? (
        <StreamingBubble text={data.streamingText.replace(/<!--task-name:.+?-->\s*/g, "")} role="assistant" />
      ) : data.status === "running" && data.messages.length > 0 ? (
        <StreamingIndicator label="Leader is thinking..." />
      ) : null}
      {debugEnabled && data.sessionKey && (
        <DebugInspector
          sessionKey={data.sessionKey}
          streamingText={data.streamingText}
          streamingBlockIndex={data.streamingBlockIndex ?? null}
          messages={data.messages}
          label="leader"
        />
      )}
      {/* Wait countdown timer */}
      {data.waitUntil && data.waitUntil > Date.now() && (
        <WaitCountdown waitUntil={data.waitUntil} reason={data.waitReason ?? "Waiting..."} />
      )}
    </div>
  );
}
