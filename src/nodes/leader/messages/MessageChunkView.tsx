import { memo, useCallback, type KeyboardEvent, type MouseEvent } from "react";
import { SimpleMarkdown } from "../../../components/SimpleMarkdown.tsx";
import { parseMessageChunks } from "../../../message-chunks.ts";

/**
 * A single content chunk inside an assistant message bubble. In chunk-
 * selection mode the chunk becomes a checkbox (click or Enter/Space
 * toggles, shift-click extends from anchor).
 */
export interface MessageChunkViewProps {
  chunk: ReturnType<typeof parseMessageChunks>[number];
  isActive: boolean;
  selected: boolean;
  onToggle: (chunkId: string, shiftKey: boolean) => void;
}

export const MessageChunkView = memo(function MessageChunkView({
  chunk,
  isActive,
  selected,
  onToggle,
}: MessageChunkViewProps) {
  const handleClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      e.stopPropagation();
      if (!e.shiftKey && window.getSelection()?.isCollapsed === false) return;
      onToggle(chunk.id, e.shiftKey);
    },
    [chunk.id, onToggle],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (!isActive || e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        onToggle(chunk.id, e.shiftKey);
      }
    },
    [chunk.id, isActive, onToggle],
  );

  return (
    <div
      data-testid="message-chunk"
      data-chunk-id={chunk.id}
      data-selected={selected ? "true" : undefined}
      className={`message-chunk${selected ? " message-chunk--selected" : ""}`}
      role={isActive ? "checkbox" : undefined}
      aria-checked={isActive ? selected : undefined}
      tabIndex={isActive ? 0 : undefined}
      onMouseDown={(e) => {
        // Shift-click picks a chunk range; don't also extend native text selection.
        if (isActive && e.shiftKey) e.preventDefault();
      }}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <span aria-hidden="true" className="message-chunk__rail" />
      <SimpleMarkdown text={chunk.rawText} />
    </div>
  );
});
