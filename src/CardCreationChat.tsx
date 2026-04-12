import { useState, useRef, useEffect, useCallback, type Dispatch } from "react";
import type { KanbanCard, KanbanAction } from "./kanban-types.ts";
import type { ServerMessage, SdkMessage, ContentBlock } from "./use-socket.ts";
import { CARD_CREATION_SYSTEM_PROMPT } from "./prompts/card-creation-system.ts";

// ─── Helpers ──────────────────────────────────────────────

let _chatIdCounter = 0;
function chatId(): string {
  return `chat-${Date.now()}-${++_chatIdCounter}`;
}

let _cardIdCounter = 0;
function cardId(): string {
  return `kb-${Date.now()}-${++_cardIdCounter}`;
}

/** Parse ```card JSON blocks from assistant text */
function parseCardBlocks(text: string): ParsedCard[] {
  const cards: ParsedCard[] = [];
  const regex = /```card\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    try {
      const raw = JSON.parse(match[1]) as Record<string, unknown>;
      if (typeof raw.title === "string" && raw.title.trim()) {
        cards.push({
          title: raw.title,
          description: typeof raw.description === "string" ? raw.description : "",
          context: typeof raw.context === "string" ? raw.context : "",
          priority: isValidPriority(raw.priority) ? raw.priority : "medium",
          subtasks: Array.isArray(raw.subtasks)
            ? (raw.subtasks as unknown[])
                .filter((s): s is string => typeof s === "string")
                .map((s) => ({ id: chatId(), title: s, done: false }))
            : [],
        });
      }
    } catch {
      // skip malformed blocks
    }
  }
  return cards;
}

function isValidPriority(v: unknown): v is KanbanCard["priority"] {
  return v === "low" || v === "medium" || v === "high" || v === "critical";
}

/** Strip ```card blocks from text for display */
function stripCardBlocks(text: string): string {
  return text.replace(/```card\s*\n[\s\S]*?```/g, "").trim();
}

// ─── Types ────────────────────────────────────────────────

interface ParsedCard {
  title: string;
  description: string;
  context: string;
  priority: KanbanCard["priority"];
  subtasks: { id: string; title: string; done: boolean }[];
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  cards: ParsedCard[];
  /** Track which parsed cards have been added */
  addedCardIds: Set<number>;
}

interface CardCreationChatProps {
  dispatch: Dispatch<KanbanAction>;
  socketSend: (data: unknown) => void;
  socketSubscribe: (fn: (msg: ServerMessage) => void) => () => void;
  onClose: () => void;
  projectPath: string;
}

// ─── Priority badge ───────────────────────────────────────

const PRIORITY_COLORS: Record<KanbanCard["priority"], string> = {
  critical: "var(--priority-critical)",
  high: "var(--priority-high)",
  medium: "var(--priority-medium)",
  low: "var(--priority-low)",
};

function PriorityDot({ priority }: { priority: KanbanCard["priority"] }) {
  return (
    <span
      className="kb-chat-card__priority-dot"
      style={{ background: PRIORITY_COLORS[priority] }}
      title={priority}
    />
  );
}

// ─── Component ────────────────────────────────────────────

export function CardCreationChat({
  dispatch,
  socketSend,
  socketSubscribe,
  onClose,
  projectPath,
}: CardCreationChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [sessionKey] = useState(() => `card-chat-${Date.now()}`);
  const [sessionReady, setSessionReady] = useState(false);
  const [streamingText, setStreamingText] = useState("");

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pendingTextRef = useRef("");
  const sessionCreatedRef = useRef(false);

  // Auto-scroll to bottom
  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingText, scrollToBottom]);

  // Create session on mount
  useEffect(() => {
    if (sessionCreatedRef.current) return;
    sessionCreatedRef.current = true;

    socketSend({
      type: "create_session",
      sessionKey,
      cwd: projectPath,
      systemPrompt: CARD_CREATION_SYSTEM_PROMPT,
      model: "sonnet",
      permissionMode: "plan",
    });
  }, [socketSend, sessionKey, projectPath]);

  // Subscribe to socket messages
  useEffect(() => {
    const unsub = socketSubscribe((msg: ServerMessage) => {
      if (msg.type === "session_status" && msg.sessionKey === sessionKey) {
        if (msg.status === "idle") {
          setSessionReady(true);
        }
      }

      if (msg.type === "session_created" && msg.sessionKey === sessionKey) {
        setSessionReady(true);
      }

      if (msg.type === "sdk_event" && msg.sessionKey === sessionKey) {
        const sdkMsg: SdkMessage = msg.message;

        // Handle streaming text
        if (sdkMsg.type === "stream_event") {
          const evt = sdkMsg.event as Record<string, unknown>;
          if (evt.type === "content_block_delta") {
            const delta = evt.delta as Record<string, unknown> | undefined;
            if (delta && delta.type === "text_delta" && typeof delta.text === "string") {
              pendingTextRef.current += delta.text;
              setStreamingText(pendingTextRef.current);
            }
          }
        }

        // Handle complete assistant message
        if (sdkMsg.type === "assistant") {
          const textBlocks = sdkMsg.message.content.filter(
            (b: ContentBlock) => b.type === "text",
          ) as { type: "text"; text: string }[];
          const fullText = textBlocks.map((b) => b.text).join("\n");
          const cards = parseCardBlocks(fullText);
          const displayText = stripCardBlocks(fullText);

          setMessages((prev) => [
            ...prev,
            {
              id: chatId(),
              role: "assistant",
              text: displayText,
              cards,
              addedCardIds: new Set(),
            },
          ]);
          pendingTextRef.current = "";
          setStreamingText("");
          setIsThinking(false);
        }

        // Handle result (session back to idle)
        if (sdkMsg.type === "result") {
          setIsThinking(false);
          pendingTextRef.current = "";
          setStreamingText("");
        }
      }
    });

    return unsub;
  }, [socketSubscribe, sessionKey]);

  // Send message
  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || isThinking || !sessionReady) return;

    setMessages((prev) => [
      ...prev,
      { id: chatId(), role: "user", text: trimmed, cards: [], addedCardIds: new Set() },
    ]);
    setInput("");
    setIsThinking(true);
    pendingTextRef.current = "";
    setStreamingText("");

    socketSend({
      type: "send_message",
      sessionKey,
      message: trimmed,
    });
  }, [input, isThinking, sessionReady, socketSend, sessionKey]);

  // Add a parsed card to the backlog
  const handleAddCard = useCallback(
    (msgId: string, cardIndex: number, parsed: ParsedCard) => {
      const card: KanbanCard = {
        id: cardId(),
        title: parsed.title,
        description: parsed.description,
        context: parsed.context,
        priority: parsed.priority,
        subtasks: parsed.subtasks,
        columnId: "backlog",
        createdAt: Date.now(),
        model: "sonnet",
        permissionMode: "auto",
        worktreeIsolation: true,
        skillIds: [],
        skillValues: {},
        linkedContextNodeIds: [],
      };
      dispatch({ type: "ADD_CARD", card });

      // Mark this card as added
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== msgId) return m;
          const next = new Set(m.addedCardIds);
          next.add(cardIndex);
          return { ...m, addedCardIds: next };
        }),
      );
    },
    [dispatch],
  );

  // Add all cards from a message
  const handleAddAll = useCallback(
    (msgId: string, cards: ParsedCard[]) => {
      cards.forEach((parsed, i) => {
        // Check if already added
        const msg = messages.find((m) => m.id === msgId);
        if (msg?.addedCardIds.has(i)) return;

        const card: KanbanCard = {
          id: cardId(),
          title: parsed.title,
          description: parsed.description,
          context: parsed.context,
          priority: parsed.priority,
          subtasks: parsed.subtasks,
          columnId: "backlog",
          createdAt: Date.now(),
          model: "sonnet",
          permissionMode: "auto",
          worktreeIsolation: true,
          skillIds: [],
          skillValues: {},
          linkedContextNodeIds: [],
        };
        dispatch({ type: "ADD_CARD", card });
      });

      // Mark all as added
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== msgId) return m;
          const next = new Set(m.addedCardIds);
          cards.forEach((_, i) => next.add(i));
          return { ...m, addedCardIds: next };
        }),
      );
    },
    [dispatch, messages],
  );

  // Cleanup session on unmount
  useEffect(() => {
    return () => {
      socketSend({ type: "close_session", sessionKey });
    };
  }, [socketSend, sessionKey]);

  // Streaming card preview
  const streamingCards = streamingText ? parseCardBlocks(streamingText) : [];
  const streamingDisplay = streamingText ? stripCardBlocks(streamingText) : "";

  return (
    <div className="kb-chat">
      {/* Header */}
      <div className="kb-chat__header">
        <div className="kb-chat__header-left">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M2 2.5A2.5 2.5 0 014.5 0h7A2.5 2.5 0 0114 2.5v8a2.5 2.5 0 01-2.5 2.5H6l-3 3v-3H2.5A2.5 2.5 0 010 10.5v-8z"
              fill="currentColor"
            />
          </svg>
          <span className="kb-chat__title">Card Creator</span>
        </div>
        <button className="kb-btn kb-btn--icon" onClick={onClose} aria-label="Close chat">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Messages */}
      <div className="kb-chat__messages" ref={scrollRef}>
        {messages.length === 0 && !isThinking && (
          <div className="kb-chat__empty">
            <div className="kb-chat__empty-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="1.5" opacity="0.4" />
                <path d="M12 8v8M8 12h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </div>
            <p>Describe what you want to accomplish and I'll help break it into task cards.</p>
            <div className="kb-chat__suggestions">
              {[
                "Build a user authentication system",
                "Refactor the API layer for better error handling",
                "Add unit tests for the payment module",
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  className="kb-chat__suggestion"
                  onClick={() => {
                    setInput(suggestion);
                    inputRef.current?.focus();
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`kb-chat__msg kb-chat__msg--${msg.role}`}>
            {msg.role === "user" ? (
              <div className="kb-chat__bubble kb-chat__bubble--user">{msg.text}</div>
            ) : (
              <div className="kb-chat__bubble kb-chat__bubble--assistant">
                {msg.text && <div className="kb-chat__text">{msg.text}</div>}
                {msg.cards.length > 0 && (
                  <div className="kb-chat__cards">
                    {msg.cards.length > 1 && (
                      <button
                        className="kb-btn kb-btn--primary kb-btn--sm kb-chat__add-all"
                        onClick={() => handleAddAll(msg.id, msg.cards)}
                        disabled={msg.cards.every((_, i) => msg.addedCardIds.has(i))}
                      >
                        {msg.cards.every((_, i) => msg.addedCardIds.has(i))
                          ? "All Added"
                          : `Add All ${msg.cards.length} Cards`}
                      </button>
                    )}
                    {msg.cards.map((card, i) => (
                      <div key={i} className="kb-chat-card">
                        <div className="kb-chat-card__header">
                          <PriorityDot priority={card.priority} />
                          <span className="kb-chat-card__title">{card.title}</span>
                          <span className="kb-chat-card__priority">{card.priority}</span>
                        </div>
                        {card.description && (
                          <div className="kb-chat-card__desc">{card.description}</div>
                        )}
                        {card.subtasks.length > 0 && (
                          <ul className="kb-chat-card__subtasks">
                            {card.subtasks.map((st) => (
                              <li key={st.id}>{st.title}</li>
                            ))}
                          </ul>
                        )}
                        <button
                          className="kb-btn kb-btn--primary kb-btn--sm kb-chat-card__add"
                          onClick={() => handleAddCard(msg.id, i, card)}
                          disabled={msg.addedCardIds.has(i)}
                        >
                          {msg.addedCardIds.has(i) ? (
                            <>
                              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                                <path d="M2 5.5L4 7.5L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                              Added
                            </>
                          ) : (
                            "Add to Backlog"
                          )}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {/* Streaming indicator */}
        {isThinking && (
          <div className="kb-chat__msg kb-chat__msg--assistant">
            <div className="kb-chat__bubble kb-chat__bubble--assistant">
              {streamingDisplay && <div className="kb-chat__text">{streamingDisplay}</div>}
              {streamingCards.length > 0 && (
                <div className="kb-chat__cards">
                  {streamingCards.map((card, i) => (
                    <div key={i} className="kb-chat-card kb-chat-card--streaming">
                      <div className="kb-chat-card__header">
                        <PriorityDot priority={card.priority} />
                        <span className="kb-chat-card__title">{card.title}</span>
                        <span className="kb-chat-card__priority">{card.priority}</span>
                      </div>
                      {card.description && (
                        <div className="kb-chat-card__desc">{card.description}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {!streamingDisplay && streamingCards.length === 0 && (
                <div className="kb-chat__thinking">
                  <span className="kb-chat__thinking-dot" />
                  <span className="kb-chat__thinking-dot" />
                  <span className="kb-chat__thinking-dot" />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="kb-chat__input-area">
        <textarea
          ref={inputRef}
          className="kb-chat__input"
          placeholder={sessionReady ? "Describe tasks to create..." : "Connecting..."}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          disabled={!sessionReady}
          rows={1}
          autoFocus
        />
        <button
          className="kb-btn kb-btn--primary kb-chat__send"
          onClick={handleSend}
          disabled={!input.trim() || isThinking || !sessionReady}
          aria-label="Send message"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M1 8h14M9 2l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
