import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { ArrowUp, X } from "lucide-react";
import "./leader-prompt.css";
import { PromptAttachmentsContext } from "./use-prompt-attachments.ts";
import { AutoTextarea } from "../../../components/AutoTextarea.tsx";
import { LeaderSlashMenu } from "./LeaderSlashMenu.tsx";
import {
  filterSlashCommands,
  parseSlashQuery,
  type SlashCommand,
} from "./slash-commands.ts";

const LeaderSlashCommandsContext = createContext<{
  commands: SlashCommand[];
  onSelect: ((command: SlashCommand) => void) | undefined;
} | undefined>(undefined);

export function LeaderSlashCommandsProvider({
  commands,
  onSelect,
  children,
}: {
  commands: SlashCommand[];
  onSelect?: (command: SlashCommand) => void;
  children: ReactNode;
}) {
  return (
    <LeaderSlashCommandsContext.Provider value={{ commands, onSelect }}>
      {children}
    </LeaderSlashCommandsContext.Provider>
  );
}

/**
 * Shared Leader prompt bar used by both the in-node prompt and the
 * zoomed-out overlay. Keep prompt UI changes here so both affordances
 * evolve together.
 */
export function LeaderPromptBar({
  input,
  onInputChange,
  onKeyDown,
  onSubmit,
  placeholder,
  submitLabel,
  disabled,
  active,
  variant = "inline",
  autoFocus = false,
  textareaRef,
  onTextareaFocus,
  slashCommands,
  portalSlashMenu = false,
}: {
  input: string;
  onInputChange: (value: string) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onSubmit: () => void;
  placeholder: string;
  submitLabel: string;
  disabled: boolean;
  active: boolean;
  variant?: "inline" | "overlay";
  autoFocus?: boolean;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  onTextareaFocus?: (() => void) | undefined;
  slashCommands?: SlashCommand[];
  /** Render slash commands at the viewport layer so constrained surfaces do not clip them. */
  portalSlashMenu?: boolean;
}) {
  const attachments = useContext(PromptAttachmentsContext);
  const slashCommandContext = useContext(LeaderSlashCommandsContext);
  const availableSlashCommands = slashCommands ?? slashCommandContext?.commands;
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const internalTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const inputWrapRef = useRef<HTMLDivElement | null>(null);
  const slashMenuId = useId();
  const resolvedTextareaRef = textareaRef ?? internalTextareaRef;
  const pendingCaretPosition = useRef<number | null>(null);
  const query = availableSlashCommands?.length
    ? parseSlashQuery(input)
    : null;
  const matches =
    query === null || !availableSlashCommands
      ? []
      : filterSlashCommands(availableSlashCommands, query);
  const menuOpen = query !== null && matches.length > 0 && !menuDismissed;
  const isOverlay = variant === "overlay";
  // Reserve the menu's rows plus its header, footer, and anchor gap inside
  // overlay composers. This keeps the absolutely positioned menu from being
  // clipped by surfaces that correctly contain their own overflow.
  const overlayMenuSpace = menuOpen && !portalSlashMenu
    ? Math.min(340, matches.length * 52 + 88)
    : 0;
  const buttonIsPrimary = active && !disabled;

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, matches.length]);

  useLayoutEffect(() => {
    const caretPosition = pendingCaretPosition.current;
    if (caretPosition === null) return;
    const textarea = resolvedTextareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(caretPosition, caretPosition);
    pendingCaretPosition.current = null;
  }, [input, resolvedTextareaRef]);

  const selectCommand = (command: SlashCommand) => {
    pendingCaretPosition.current = command.insertText.length;
    onInputChange(command.insertText);
    slashCommandContext?.onSelect?.(command);
    setMenuDismissed(true);
  };

  const handleInputChange = (value: string) => {
    onInputChange(value);
    setMenuDismissed(false);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (!menuOpen) {
      onKeyDown(event);
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((index) => Math.min(matches.length - 1, index + 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((index) => Math.max(0, index - 1));
      return;
    }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      event.preventDefault();
      if (event.key === "Enter") event.stopPropagation();
      const command = matches[selectedIndex];
      if (command) selectCommand(command);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setMenuDismissed(true);
      return;
    }

    onKeyDown(event);
  };

  return (
    <div
      data-testid={`leader-prompt-bar-${variant}`}
      data-no-drag
      className={`leader-prompt-bar leader-prompt-bar--${variant}`}
      style={isOverlay ? { paddingTop: 10 + overlayMenuSpace } : undefined}
    >
      <div className="leader-prompt-bar__surface">
        {attachments && attachments.drafts.length > 0 && (
          <ul className="leader-prompt-bar__attachments" aria-label="Attached context">
            {attachments.drafts.map(draft => (
              <li key={draft.id}>
                {draft.preview && <img src={draft.preview} alt={draft.filename} />}
                <span>{draft.filename}{!draft.item && !draft.error ? " — Loading…" : ""}
                  {draft.error && <span role="alert">{draft.error}</span>}
                </span>
                <button type="button" aria-label={`Remove ${draft.filename}`}
                  onClick={() => attachments.remove([draft.id])}><X size={14} /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="leader-prompt-bar__input-wrap" ref={inputWrapRef}>
          {menuOpen && (() => {
            const menu = (
              <LeaderSlashMenu
                id={slashMenuId}
                commands={matches}
                selectedIndex={selectedIndex}
                onSelect={selectCommand}
                onHover={setSelectedIndex}
                query={query ?? ""}
                {...(portalSlashMenu ? { anchorRef: inputWrapRef } : {})}
              />
            );
            return portalSlashMenu && typeof document !== "undefined"
              ? createPortal(menu, document.body)
              : menu;
          })()}
          <AutoTextarea
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            {...(attachments ? { onPaste: attachments.onPaste } : {})}
            autoFocus={autoFocus}
            ariaLabel="Leader prompt"
            ariaControls={query !== null ? slashMenuId : undefined}
            ariaExpanded={menuOpen}
            ariaActiveDescendant={menuOpen && matches[selectedIndex]
              ? `${slashMenuId}-option-${matches[selectedIndex].id}`
              : undefined}
            testId={`leader-prompt-input-${variant}`}
            placeholder={placeholder}
            maxRows={isOverlay ? 10 : 8}
            {...(onTextareaFocus ? { onFocus: onTextareaFocus } : {})}
            textareaRef={resolvedTextareaRef}
            style={{
              fontSize: isOverlay ? 15 : 12,
              lineHeight: isOverlay ? "24px" : "20px",
              padding: isOverlay ? "14px 14px 10px" : "12px 12px 8px",
              minHeight: isOverlay ? 64 : 48,
              border: 0,
              borderRadius: 0,
              background: "transparent",
              boxShadow: "none",
              display: "block",
            }}
          />
        </div>
        <div className="leader-prompt-bar__toolbar">
          <span className="leader-prompt-bar__hint" aria-hidden="true">
            {availableSlashCommands?.length ? <span>/ commands</span> : null}
            {attachments && <span>Paste images or text files</span>}
            <span>Shift + Enter for a new line</span>
          </span>
          <button
            type="button"
            className="leader-prompt-bar__submit"
            data-primary={buttonIsPrimary}
            onClick={onSubmit}
            onMouseDown={(e) => e.stopPropagation()}
            disabled={disabled}
          >
            {submitLabel}
            <ArrowUp size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
