import type { SkillTemplate } from "../../../skills/types.ts";

/**
 * Renders the configurable variables for a single skill — supports
 * text, textarea, and select input types. Used inside {@link SkillFlyout}
 * for each armed skill.
 */
export function SkillVariableInputs({
  skill,
  values,
  onChange,
  readOnly,
}: {
  skill: SkillTemplate;
  values: Record<string, string>;
  onChange: (varName: string, value: string) => void;
  readOnly: boolean;
}) {
  if (skill.variables.length === 0) return null;

  return (
    <div style={{ padding: "6px 0", display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          color: skill.accentColor,
          opacity: 0.8,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          fontWeight: 600,
        }}
      >
        {skill.icon} {skill.name}
      </div>
      {skill.variables.map((v) => (
        <div key={v.name} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <label
            style={{
              fontSize: 11,
              color: "var(--text-secondary)",
              fontFamily: "var(--font-mono)",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            {v.label}
            {v.required && (
              <span style={{ color: "var(--danger-color)", fontSize: 10 }}>*</span>
            )}
          </label>
          {v.type === "select" ? (
            <select
              value={values[v.name] ?? v.defaultValue ?? ""}
              onChange={(e) => onChange(v.name, e.target.value)}
              onMouseDown={(e) => e.stopPropagation()}
              disabled={readOnly}
              style={{
                padding: "6px 8px",
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                background: "var(--bg-primary)",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                color: "var(--text-primary)",
                outline: "none",
                opacity: readOnly ? 0.6 : 1,
              }}
            >
              {v.options?.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          ) : v.type === "textarea" ? (
            <textarea
              value={values[v.name] ?? v.defaultValue ?? ""}
              onChange={(e) => onChange(v.name, e.target.value)}
              onMouseDown={(e) => e.stopPropagation()}
              readOnly={readOnly}
              placeholder={v.placeholder}
              rows={2}
              style={{
                padding: "6px 8px",
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                background: "var(--bg-primary)",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                color: "var(--text-primary)",
                outline: "none",
                resize: "vertical",
                opacity: readOnly ? 0.6 : 1,
              }}
            />
          ) : (
            <input
              type="text"
              value={values[v.name] ?? v.defaultValue ?? ""}
              onChange={(e) => onChange(v.name, e.target.value)}
              onMouseDown={(e) => e.stopPropagation()}
              readOnly={readOnly}
              placeholder={v.placeholder}
              style={{
                padding: "6px 8px",
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                background: "var(--bg-primary)",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                color: "var(--text-primary)",
                outline: "none",
                opacity: readOnly ? 0.6 : 1,
              }}
            />
          )}
          {v.description && (
            <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              {v.description}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
