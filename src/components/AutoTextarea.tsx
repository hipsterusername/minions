import { useRef, useCallback, useEffect } from "react";

interface AutoTextareaProps {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  placeholder?: string;
  maxRows?: number;
  disabled?: boolean;
  style?: React.CSSProperties;
}

/**
 * A textarea that auto-grows from 1 row up to `maxRows` based on content.
 * Also supports Shift+Enter for newlines (Enter is handled by parent onKeyDown).
 */
export function AutoTextarea({
  value,
  onChange,
  onKeyDown,
  placeholder,
  maxRows = 8,
  disabled,
  style,
}: AutoTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
    const maxHeight = lineHeight * maxRows + 16; // 16 = padding
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [maxRows]);

  useEffect(() => {
    resize();
  }, [value, resize]);

  return (
    <div style={{ position: "relative", flex: 1 }}>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        style={{
          width: "100%",
          padding: "8px 10px",
          background: "var(--bg-primary)",
          border: "1px solid var(--border-default)",
          borderRadius: 6,
          color: "var(--text-primary)",
          fontSize: 12,
          fontFamily: "var(--font-sans)",
          resize: "none",
          outline: "none",
          lineHeight: "20px",
          overflow: "auto",
          boxSizing: "border-box",
          transition: "border-color 0.15s",
          ...style,
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = "var(--border-hover)";
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = "var(--border-default)";
        }}
      />
      {/* Hint for multiline */}
      {value.length === 0 && (
        <span
          style={{
            position: "absolute",
            right: 8,
            bottom: 4,
            fontSize: 9,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            pointerEvents: "none",
            opacity: 0.5,
          }}
        >
          ⇧↵ newline
        </span>
      )}
    </div>
  );
}
