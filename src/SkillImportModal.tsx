import { useMemo, useState } from "react";
import type { SkillTemplate } from "./skills/types.ts";

interface SkillImportModalProps {
  /** Validated skills parsed from the imported file. */
  incoming: SkillTemplate[];
  /** IDs already present in the project library (used to flag overwrites). */
  existingIds: Set<string>;
  /** Number of malformed entries dropped during parsing (shown as a note). */
  skipped?: number;
  /** Called with the user-selected subset to actually import. */
  onConfirm: (selected: SkillTemplate[]) => void;
  onClose: () => void;
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay-bg)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 9999,
};

const modalStyle: React.CSSProperties = {
  width: 480,
  maxHeight: "85vh",
  overflow: "hidden",
  background: "var(--bg-secondary)",
  border: "1px solid var(--border-default)",
  borderRadius: 8,
  fontFamily: "var(--font-sans)",
  color: "var(--text-primary)",
  display: "flex",
  flexDirection: "column",
};

const btnBase: React.CSSProperties = {
  padding: "8px 16px",
  borderRadius: 6,
  border: "1px solid var(--border-default)",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: "var(--font-sans)",
};

function badge(kind: "new" | "overwrite"): React.CSSProperties {
  return {
    fontSize: 9,
    fontFamily: "var(--font-mono)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    padding: "1px 6px",
    borderRadius: 10,
    flexShrink: 0,
    color: kind === "new" ? "var(--success-color)" : "var(--warning-color)",
    border: `1px solid ${
      kind === "new" ? "var(--success-color)" : "var(--warning-color)"
    }`,
  };
}

export function SkillImportModal({
  incoming,
  existingIds,
  skipped = 0,
  onConfirm,
  onClose,
}: SkillImportModalProps) {
  // Default: everything selected.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(incoming.map((s) => s.id)),
  );

  const conflictCount = useMemo(
    () => incoming.filter((s) => existingIds.has(s.id)).length,
    [incoming, existingIds],
  );

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allSelected = selected.size === incoming.length && incoming.length > 0;
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(incoming.map((s) => s.id)));
  };

  const handleConfirm = () => {
    onConfirm(incoming.filter((s) => selected.has(s.id)));
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div
        style={modalStyle}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderBottom: "1px solid var(--border-default)",
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Import Skills</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              fontSize: 20,
              cursor: "pointer",
              padding: "0 4px",
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {/* Summary + select all */}
        <div
          style={{
            padding: "10px 20px",
            borderBottom: "1px solid var(--border-default)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            {incoming.length} skill{incoming.length === 1 ? "" : "s"} found
            {conflictCount > 0 && (
              <span style={{ color: "var(--warning-color)" }}>
                {" "}· {conflictCount} overwrite{conflictCount === 1 ? "" : "s"}
              </span>
            )}
            {skipped > 0 && (
              <span style={{ color: "var(--text-muted)" }}> · {skipped} skipped</span>
            )}
          </div>
          {incoming.length > 0 && (
            <button
              onClick={toggleAll}
              style={{
                ...btnBase,
                padding: "3px 10px",
                fontSize: 11,
                background: "var(--bg-primary)",
                color: "var(--text-secondary)",
              }}
            >
              {allSelected ? "Deselect all" : "Select all"}
            </button>
          )}
        </div>

        {/* Skill list */}
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px" }}>
          {incoming.length === 0 && (
            <div
              style={{
                padding: "24px 12px",
                textAlign: "center",
                color: "var(--text-muted)",
                fontSize: 12,
                fontStyle: "italic",
              }}
            >
              No valid skills found in this file.
            </div>
          )}
          {incoming.map((skill) => {
            const isConflict = existingIds.has(skill.id);
            const isChecked = selected.has(skill.id);
            return (
              <label
                key={skill.id}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  padding: "8px 10px",
                  borderRadius: 6,
                  cursor: "pointer",
                  background: isChecked ? "var(--bg-surface)" : "transparent",
                  border: "1px solid",
                  borderColor: isChecked
                    ? "var(--border-default)"
                    : "transparent",
                  marginBottom: 4,
                }}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggle(skill.id)}
                  style={{ marginTop: 3, flexShrink: 0 }}
                />
                <span style={{ fontSize: 16, lineHeight: 1.2, flexShrink: 0 }}>
                  {skill.icon}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      marginBottom: 2,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: "var(--text-primary)",
                      }}
                    >
                      {skill.name}
                    </span>
                    <span style={badge(isConflict ? "overwrite" : "new")}>
                      {isConflict ? "Overwrites" : "New"}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted)",
                      lineHeight: 1.3,
                    }}
                  >
                    {skill.description || "No description"}
                  </div>
                </div>
              </label>
            );
          })}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "14px 20px",
            borderTop: "1px solid var(--border-default)",
          }}
        >
          <button
            onClick={onClose}
            style={{
              ...btnBase,
              background: "var(--bg-primary)",
              color: "var(--text-secondary)",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={selected.size === 0}
            style={{
              ...btnBase,
              background: selected.size === 0 ? "var(--bg-primary)" : "var(--accent)",
              color: selected.size === 0 ? "var(--text-muted)" : "white",
              border: "1px solid var(--accent)",
              fontWeight: 600,
              cursor: selected.size === 0 ? "not-allowed" : "pointer",
              opacity: selected.size === 0 ? 0.6 : 1,
            }}
          >
            Import {selected.size > 0 ? selected.size : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
