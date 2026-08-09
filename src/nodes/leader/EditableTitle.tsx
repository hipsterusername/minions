import { useEffect, useRef, useState } from "react";

/**
 * Inline-editable label used in the Leader node header. Double-click to enter
 * edit mode, Enter/blur to commit, Escape to cancel. Falls back to the
 * previous value if the user submits whitespace.
 */
export function EditableTitle({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (!editing) {
    return (
      <span
        className="leader-editable-title"
        onDoubleClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
        style={{
          cursor: "default",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={`${value} (double-click to rename)`}
      >
        {value}
      </span>
    );
  }

  const commit = () => {
    const trimmed = draft.trim();
    onChange(trimmed || value);
    setEditing(false);
  };

  return (
    <input
      className="leader-editable-title__input"
      ref={inputRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          setDraft(value);
          setEditing(false);
        }
        e.stopPropagation();
      }}
      onMouseDown={(e) => e.stopPropagation()}
    />
  );
}
