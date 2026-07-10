import {
  memo,
  useCallback,
  useMemo,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { chatRoleStyle } from "../../../chat-bubble-style.ts";
import { joinSelectedChunks, parseMessageChunks } from "../../../message-chunks.ts";
import type { LeaderMessage, MessageContextSelection } from "../types.ts";
import { copyText as copyToClipboard } from "../../../components/CopyButton.tsx";
import { LeaderMessageActions } from "./MessageActions.tsx";
import { MessageChunkView } from "./MessageChunkView.tsx";
import {
  MessageSelectionButton,
  MessageSelectionGroup,
} from "./MessageSelection.tsx";
import { browserLogger } from "../../../logging.ts";

const log = browserLogger.child("selectable-message-bubble");

/**
 * Returns true if the selection state relevant to `messageId` changed
 * between two snapshots. Used by {@link SelectableMessageBubble}'s
 * `React.memo` comparator to avoid re-renders for unrelated selection
 * changes elsewhere on the canvas.
 */
export function selectionForMessageChanged(
  prev: MessageContextSelection | null,
  next: MessageContextSelection | null,
  messageId: string,
): boolean {
  const prevActive = prev?.messageId === messageId;
  const nextActive = next?.messageId === messageId;
  if (prevActive !== nextActive) return true;
  if (!prevActive || !nextActive) return false;
  if (prev.anchorChunkId !== next.anchorChunkId) return true;
  if (prev.selectedChunkIds.length !== next.selectedChunkIds.length) return true;
  return prev.selectedChunkIds.some(
    (id, index) => id !== next.selectedChunkIds[index],
  );
}

/**
 * Assistant / result message bubble with built-in chunk-selection mode.
 * Click to enter selection mode → individual chunks become checkboxes;
 * the floating toolbar exposes select-all, clear, copy-selected,
 * add-selected-as-node, copy-full, and exit.
 *
 * Extracted from `src/nodes/LeaderNode.tsx` (Phase 4 of the leader refactor).
 */
export const SelectableMessageBubble = memo(
  function SelectableMessageBubble({
    msg,
    selection,
    onActivate,
    onSelectionChange,
    onExit,
    onAddContentNode,
  }: {
    msg: LeaderMessage;
    selection: MessageContextSelection | null;
    onActivate: (messageId: string) => void;
    onSelectionChange: (selection: MessageContextSelection) => void;
    onExit: () => void;
    onAddContentNode?: ((content: string) => void) | undefined;
  }) {
    const [copied, setCopied] = useState(false);
    const chunks = useMemo(() => parseMessageChunks(msg.content), [msg.content]);
    const isActive = selection?.messageId === msg.id;
    const selectedIds = useMemo(
      () => new Set(isActive ? selection.selectedChunkIds : []),
      [isActive, selection?.selectedChunkIds],
    );
    const selectedText = useMemo(
      () => joinSelectedChunks(chunks, selectedIds),
      [chunks, selectedIds],
    );
    const selectedCount = selectedIds.size;

    const updateSelectedIds = useCallback(
      (nextIds: string[], anchorChunkId: string | null) => {
        onSelectionChange({
          messageId: msg.id,
          selectedChunkIds: nextIds,
          anchorChunkId,
        });
      },
      [msg.id, onSelectionChange],
    );

    const toggleChunk = useCallback(
      (chunkId: string, shiftKey: boolean) => {
        if (shiftKey && isActive && selection?.anchorChunkId) {
          const anchorIndex = chunks.findIndex(
            (chunk) => chunk.id === selection.anchorChunkId,
          );
          const currentIndex = chunks.findIndex((chunk) => chunk.id === chunkId);
          if (anchorIndex >= 0 && currentIndex >= 0) {
            const [start, end] =
              anchorIndex < currentIndex
                ? [anchorIndex, currentIndex]
                : [currentIndex, anchorIndex];
            updateSelectedIds(
              chunks.slice(start, end + 1).map((chunk) => chunk.id),
              selection.anchorChunkId,
            );
            return;
          }
        }

        const next = new Set(isActive ? selection?.selectedChunkIds ?? [] : []);
        if (next.has(chunkId)) {
          next.delete(chunkId);
        } else {
          next.add(chunkId);
        }
        updateSelectedIds([...next], chunkId);
      },
      [chunks, isActive, selection, updateSelectedIds],
    );

    const copyText = useCallback((text: string) => {
      void copyToClipboard(text)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
        .catch((err: unknown) => {
          log.warn("copy_failed", { error: err });
        });
    }, []);

    const handleToolbarClick = useCallback((e: MouseEvent<HTMLDivElement>) => {
      e.stopPropagation();
    }, []);

    const handleContainerClick = useCallback(() => {
      if (!isActive) onActivate(msg.id);
    }, [isActive, msg.id, onActivate]);

    const handleContainerKeyDown = useCallback(
      (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === "Escape" && isActive) {
          e.stopPropagation();
          onExit();
        }
        if ((e.key === "Enter" || e.key === " ") && !isActive) {
          e.preventDefault();
          onActivate(msg.id);
        }
      },
      [isActive, msg.id, onActivate, onExit],
    );

    const handleSelectAll = useCallback(
      (e: MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        updateSelectedIds(
          chunks.map((chunk) => chunk.id),
          chunks[0]?.id ?? null,
        );
      },
      [chunks, updateSelectedIds],
    );

    const handleClearSelection = useCallback(
      (e: MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        updateSelectedIds([], null);
      },
      [updateSelectedIds],
    );

    const handleCopySelected = useCallback(
      (e: MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        copyText(selectedText);
      },
      [copyText, selectedText],
    );

    const handleAddSelected = useCallback(
      (e: MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        onAddContentNode?.(selectedText);
      },
      [onAddContentNode, selectedText],
    );

    const handleCopyFull = useCallback(
      (e: MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        copyText(msg.content);
      },
      [copyText, msg.content],
    );

    const handleExitSelection = useCallback(
      (e: MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        onExit();
      },
      [onExit],
    );

    return (
      <div
        className={`copyable message-selectable${isActive ? " message-selectable--active" : ""}`}
        data-testid="selectable-message"
        data-selected={isActive ? "true" : undefined}
        role="button"
        tabIndex={0}
        aria-label="Select message chunks"
        aria-pressed={isActive}
        onClick={handleContainerClick}
        onKeyDown={handleContainerKeyDown}
        style={{
          ...chatRoleStyle(msg.role === "result" ? "result" : "assistant"),
          position: "relative",
        }}
      >
        {isActive ? (
          <div
            data-testid="leader-message-selection-toolbar"
            style={{
              position: "sticky",
              top: 8,
              zIndex: 7,
              minHeight: 28,
              display: "flex",
              justifyContent: "flex-end",
              pointerEvents: "none",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: 2,
                borderRadius: 5,
                background: "var(--bg-primary)",
                border: "1px solid var(--border-default)",
                boxShadow: "var(--shadow-sm)",
                pointerEvents: "auto",
              }}
              onClick={handleToolbarClick}
            >
              <span
                aria-live="polite"
                style={{
                  padding: "0 5px",
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  whiteSpace: "nowrap",
                }}
              >
                {selectedCount} chunk{selectedCount === 1 ? "" : "s"}
              </span>
              <MessageSelectionGroup label="Selection controls">
                <MessageSelectionButton
                  icon="select-all"
                  label="Select all chunks"
                  onClick={handleSelectAll}
                  disabled={chunks.length === 0}
                />
                <MessageSelectionButton
                  icon="clear"
                  label="Clear selected chunks"
                  onClick={handleClearSelection}
                  disabled={selectedCount === 0}
                />
              </MessageSelectionGroup>
              <MessageSelectionGroup label="Copy and create actions">
                <MessageSelectionButton
                  icon="copy"
                  label="Copy selected chunks"
                  onClick={handleCopySelected}
                  disabled={selectedText.length === 0}
                  tone="primary"
                />
                <MessageSelectionButton
                  icon="node"
                  label="Add selected chunks as node"
                  onClick={handleAddSelected}
                  disabled={!onAddContentNode || selectedText.length === 0}
                  tone="primary"
                />
                <MessageSelectionButton
                  icon="copy-full"
                  label="Copy full message"
                  onClick={handleCopyFull}
                  tone="primary"
                />
              </MessageSelectionGroup>
              <MessageSelectionGroup label="Selection mode">
                <MessageSelectionButton
                  icon="exit"
                  label="Exit chunk selection"
                  onClick={handleExitSelection}
                />
              </MessageSelectionGroup>
            </div>
          </div>
        ) : (
          <LeaderMessageActions
            text={msg.content}
            onAddContentNode={onAddContentNode}
          />
        )}

        <div data-testid="leader-message-chunks">
          {chunks.map((chunk) => (
            <MessageChunkView
              key={chunk.id}
              chunk={chunk}
              isActive={isActive}
              selected={selectedIds.has(chunk.id)}
              onToggle={toggleChunk}
            />
          ))}
        </div>
        {msg.suffix && (
          <span
            style={{
              display: "inline-block",
              marginLeft: 6,
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              color: "var(--text-muted)",
              opacity: 0.7,
            }}
          >
            {msg.suffix}
          </span>
        )}
        {copied && (
          <span
            role="status"
            style={{
              position: "absolute",
              right: 10,
              bottom: 2,
              color: "var(--status-success)",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
            }}
          >
            Copied
          </span>
        )}
      </div>
    );
  },
  (prev, next) =>
    prev.msg.id === next.msg.id &&
    prev.msg.role === next.msg.role &&
    prev.msg.content === next.msg.content &&
    prev.msg.suffix === next.msg.suffix &&
    prev.onActivate === next.onActivate &&
    prev.onSelectionChange === next.onSelectionChange &&
    prev.onExit === next.onExit &&
    prev.onAddContentNode === next.onAddContentNode &&
    !selectionForMessageChanged(prev.selection, next.selection, prev.msg.id),
);
