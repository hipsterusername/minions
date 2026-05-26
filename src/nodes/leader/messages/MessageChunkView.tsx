import { memo, useCallback, type KeyboardEvent, type MouseEvent } from "react";
import { SimpleMarkdown } from "../../../components/SimpleMarkdown.tsx";
import { parseMessageChunks } from "../../../message-chunks.ts";

/**
 * A single content chunk inside an assistant message bubble. In chunk-
 * selection mode the chunk becomes a checkbox (click or Enter/Space
 * toggles, shift-click extends from anchor).
 *
 * Extracted from `src/nodes/LeaderNode.tsx` (Phase 4 of the leader refactor).
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
      if (!isActive) return;
      e.stopPropagation();
      onToggle(chunk.id, e.shiftKey);
    },
    [chunk.id, isActive, onToggle],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (!isActive) return;
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
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {isActive && (
        <span aria-hidden="true" className="message-chunk__marker">
          {selected ? "✓" : "+"}
        </span>
      )}
      <SimpleMarkdown text={chunk.rawText} />
    </div>
  );
});
