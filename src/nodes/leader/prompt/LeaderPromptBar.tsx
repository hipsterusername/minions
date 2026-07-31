import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { AutoTextarea } from "../../../components/AutoTextarea.tsx";
import { LeaderSlashMenu } from "./LeaderSlashMenu.tsx";
import {
  filterSlashCommands,
  parseSlashQuery,
  type SlashCommand,
} from "./slash-commands.ts";

const LeaderSlashCommandsContext = createContext<SlashCommand[] | undefined>(
  undefined,
);

export function LeaderSlashCommandsProvider({
  commands,
  children,
}: {
  commands: SlashCommand[];
  children: ReactNode;
}) {
  return (
    <LeaderSlashCommandsContext.Provider value={commands}>
      {children}
    </LeaderSlashCommandsContext.Provider>
  );
}

/**
 * Shared Leader prompt bar used by both the in-node prompt and the
 * zoomed-out overlay. Keep prompt UI changes here so both affordances
 * evolve together.
 *
 * Extracted from `src/nodes/LeaderNode.tsx` (Phase 8 of the leader refactor).
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
}) {
  const contextSlashCommands = useContext(LeaderSlashCommandsContext);
  const availableSlashCommands = slashCommands ?? contextSlashCommands;
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const internalTextareaRef = useRef<HTMLTextAreaElement | null>(null);
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
  const overlayMenuSpace = menuOpen ? Math.min(340, matches.length * 52 + 88) : 0;
  const buttonHeight = isOverlay ? 52 : 38;
  const buttonMinWidth = isOverlay ? 124 : 88;
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
      style={{
        padding: isOverlay
          ? `${10 + overlayMenuSpace}px 10px 10px`
          : "8px 10px",
        borderTop: isOverlay ? "none" : "1px solid var(--border-default)",
        display: "flex",
        gap: isOverlay ? 8 : 6,
        flexShrink: 0,
        background: isOverlay ? "transparent" : "var(--bg-secondary)",
        alignItems: "flex-end",
      }}
    >
      <div className="leader-prompt-bar__input-wrap">
        {menuOpen && (
          <LeaderSlashMenu
            commands={matches}
            selectedIndex={selectedIndex}
            onSelect={selectCommand}
            onHover={setSelectedIndex}
            query={query ?? ""}
          />
        )}
        <AutoTextarea
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          autoFocus={autoFocus}
          ariaLabel="Leader prompt"
          testId={`leader-prompt-input-${variant}`}
          placeholder={placeholder}
          maxRows={isOverlay ? 10 : 8}
          {...(onTextareaFocus ? { onFocus: onTextareaFocus } : {})}
          textareaRef={resolvedTextareaRef}
          style={{
            fontSize: isOverlay ? 15 : 12,
            lineHeight: isOverlay ? "24px" : "20px",
            padding: isOverlay ? "12px 14px" : "8px 10px",
            minHeight: isOverlay ? 52 : undefined,
          }}
        />
      </div>
      <button
        type="button"
        className="leader-prompt-bar__submit"
        onClick={onSubmit}
        onMouseDown={(e) => e.stopPropagation()}
        disabled={disabled}
        style={{
          height: buttonHeight,
          minWidth: buttonMinWidth,
          padding: isOverlay ? "0 18px" : "0 14px",
          borderRadius: 6,
          border: buttonIsPrimary
            ? "1px solid var(--accent)"
            : "1px solid var(--border-default)",
          background: buttonIsPrimary ? "var(--accent)" : "var(--bg-elevated)",
          color: buttonIsPrimary ? "var(--text-on-accent)" : "var(--text-muted)",
          fontSize: isOverlay ? 13 : 12,
          fontWeight: 700,
          cursor: disabled ? "not-allowed" : "pointer",
          flexShrink: 0,
          opacity: disabled ? 0.62 : 1,
          marginBottom: isOverlay ? 0 : 1,
          boxShadow: buttonIsPrimary
            ? "0 2px 8px color-mix(in srgb, var(--accent) 24%, transparent)"
            : "none",
          transition:
            "background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease",
          whiteSpace: "nowrap",
          lineHeight: 1,
        }}
      >
        {submitLabel}
      </button>
    </div>
  );
}
