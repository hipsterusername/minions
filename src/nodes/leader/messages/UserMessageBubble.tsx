import { memo, useCallback, useState } from "react";
import { chatRoleStyle } from "../../../chat-bubble-style.ts";
import { CopyButton } from "../../../components/CopyButton.tsx";
import { MessageTimestamp } from "../../../components/MessageTimestamp.tsx";
import { UserContextHeader } from "../../../components/UserContextHeader.tsx";
import type { LeaderMessage } from "../types.ts";

/**
 * The user-side chat bubble. Auto-collapses once content exceeds ~300
 * characters and exposes a "show more / less" toggle.
 *
 * Extracted from `src/nodes/LeaderNode.tsx` (Phase 4 of the leader refactor).
 */
export const UserMessageBubble = memo(function UserMessageBubble({
  msg,
}: {
  msg: LeaderMessage;
}) {
  const [collapsed, setCollapsed] = useState(msg.content.length > 300);
  const isLong = msg.content.length > 300;
  const toggleCollapsed = useCallback(
    () => setCollapsed((value) => !value),
    [],
  );

  return (
    <div
      className="copyable"
      style={{
        ...chatRoleStyle("user"),
        position: "relative",
      }}
    >
      <CopyButton text={msg.content} />
      <UserContextHeader />
      {collapsed ? msg.content.slice(0, 200) + "…" : msg.content}
      {isLong && (
        <button
          onClick={toggleCollapsed}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            display: "inline-block",
            marginLeft: 6,
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            color: "var(--accent)",
            background: "none",
            border: "none",
            cursor: "pointer",
            textDecoration: "underline",
            opacity: 0.7,
            padding: 0,
          }}
        >
          {collapsed ? "show more" : "show less"}
        </button>
      )}
      <div className="leader-message-meta">
        <MessageTimestamp timestamp={msg.timestamp} />
      </div>
    </div>
  );
});
