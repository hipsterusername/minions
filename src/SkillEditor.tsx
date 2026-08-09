import { useState, useMemo, useCallback } from "react";
import type { SkillTemplate, SkillVariable, SubSkill } from "./skills/types.ts";
import {
  extractVariableNames,
  compileSkillTemplate,
  buildSubskillMap,
} from "./skills/types.ts";
import { SkillSubskillEditor } from "./SkillSubskillEditor.tsx";

interface SkillEditorProps {
  /** Existing skill to edit, or null for creating a new one */
  skill: SkillTemplate | null;
  /** Called when user saves. Receives the complete SkillTemplate. */
  onSave: (skill: SkillTemplate) => void;
  /** Called when user cancels */
  onClose: () => void;
}

/** The editor's navigable categories (the side rail). */
type EditorCategory = "essentials" | "appearance" | "variables" | "subskills";

const CATEGORIES: SkillTemplate["category"][] = [
  "code",
  "docs",
  "testing",
  "devops",
  "analysis",
  "design",
  "general",
];

const VARIABLE_TYPES: SkillVariable["type"][] = ["text", "textarea", "select"];

function generateId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function titleCase(s: string): string {
  return s
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
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
  width: 940,
  maxWidth: "95vw",
  height: "86vh",
  maxHeight: "86vh",
  background: "var(--bg-secondary)",
  border: "1px solid var(--border-default)",
  borderRadius: 8,
  fontFamily: "var(--font-sans)",
  color: "var(--text-primary)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "15px 20px",
  borderBottom: "1px solid var(--border-default)",
  flexShrink: 0,
};

/** rail | form | preview */
const bodyRowStyle: React.CSSProperties = {
  display: "flex",
  flex: 1,
  minHeight: 0,
};

const railStyle: React.CSSProperties = {
  width: 212,
  flexShrink: 0,
  borderRight: "1px solid var(--border-default)",
  background: "var(--bg-secondary)",
  padding: "12px 10px",
  display: "flex",
  flexDirection: "column",
  gap: 3,
  overflow: "auto",
};

const formPaneStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "auto",
  background: "var(--bg-primary)",
  padding: "18px 22px",
};

const previewPaneStyle: React.CSSProperties = {
  width: 330,
  flexShrink: 0,
  borderLeft: "1px solid var(--border-default)",
  background: "var(--bg-primary)",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  color: "var(--text-secondary)",
  marginBottom: 4,
  fontFamily: "var(--font-sans)",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 10px",
  background: "var(--bg-primary)",
  border: "1px solid var(--border-default)",
  borderRadius: 6,
  color: "var(--text-primary)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: "pointer",
};

const footerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "13px 20px",
  borderTop: "1px solid var(--border-default)",
  flexShrink: 0,
};

const btnBase: React.CSSProperties = {
  padding: "8px 16px",
  borderRadius: 6,
  border: "1px solid var(--border-default)",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: "var(--font-sans)",
};

const panelTitleStyle: React.CSSProperties = {
  margin: "0 0 4px",
  fontSize: 14,
  fontWeight: 600,
  color: "var(--text-primary)",
};

const panelHintStyle: React.CSSProperties = {
  margin: "0 0 16px",
  fontSize: 12,
  color: "var(--text-muted)",
  lineHeight: 1.5,
};

function emptyVariable(name: string): SkillVariable {
  return {
    name,
    label: titleCase(name),
    type: "text",
    required: false,
  };
}

/**
 * A single entry in the category rail. The title is rendered as a `<label>`
 * (some tests locate categories by that role) alongside an optional count
 * badge and a status dot.
 */
function RailItem({
  title,
  sublabel,
  glyph,
  active,
  badge,
  status,
  onClick,
}: {
  title: string;
  sublabel: string;
  glyph: React.ReactNode;
  active: boolean;
  badge?: number;
  status?: "ok" | "warn";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        textAlign: "left",
        padding: "9px 10px",
        borderRadius: 8,
        cursor: "pointer",
        fontFamily: "var(--font-sans)",
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        background: active ? "var(--bg-elevated)" : "transparent",
        border: active
          ? "1px solid var(--border-default)"
          : "1px solid transparent",
      }}
    >
      <span
        style={{
          width: 26,
          height: 26,
          flexShrink: 0,
          borderRadius: 7,
          background: "var(--bg-primary)",
          border: active
            ? "1px solid color-mix(in srgb, var(--accent) 55%, var(--border-default))"
            : "1px solid var(--border-default)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 13,
        }}
      >
        {glyph}
      </span>
      <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <label style={{ fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
          {title}
        </label>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {sublabel}
        </span>
      </span>
      {badge != null && badge > 0 && (
        <span
          style={{
            marginLeft: "auto",
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            color: active ? "var(--accent)" : "var(--text-muted)",
            background: "var(--bg-primary)",
            border: active
              ? "1px solid color-mix(in srgb, var(--accent) 40%, var(--border-default))"
              : "1px solid var(--border-default)",
            borderRadius: 9,
            padding: "1px 7px",
          }}
        >
          {badge}
        </span>
      )}
      {badge == null && status && (
        <span
          style={{
            marginLeft: "auto",
            width: 7,
            height: 7,
            borderRadius: "50%",
            background:
              status === "ok"
                ? "var(--status-success, #34d399)"
                : "var(--status-warning, #fbbf24)",
          }}
        />
      )}
    </button>
  );
}

/**
 * Compact, individually-expandable variable row. Collapsed it shows a summary
 * (name · type · required); expanded it reveals the full field set.
 */
function VariableRow({
  v,
  isRemoved,
  onUpdate,
  onRemove,
  onAddOption,
  onUpdateOption,
  onRemoveOption,
}: {
  v: SkillVariable & { _removed?: boolean };
  isRemoved: boolean;
  onUpdate: (updates: Partial<SkillVariable>) => void;
  onRemove: () => void;
  onAddOption: () => void;
  onUpdateOption: (optIdx: number, field: "value" | "label", val: string) => void;
  onRemoveOption: (optIdx: number) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div
      style={{
        background: "var(--bg-primary)",
        border: "1px solid var(--border-default)",
        borderRadius: 6,
        opacity: isRemoved ? 0.55 : 1,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
        }}
      >
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          disabled={isRemoved}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flex: 1,
            minWidth: 0,
            background: "none",
            border: "none",
            cursor: isRemoved ? "default" : "pointer",
            padding: 0,
            textAlign: "left",
          }}
        >
          {!isRemoved && (
            <span style={{ fontSize: 9, color: "var(--text-muted)", width: 9 }}>
              {open ? "▼" : "▶"}
            </span>
          )}
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              color: "var(--accent)",
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            {`{{${v.name}}}`}
          </span>
          {!isRemoved && (
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              {v.type}
              {v.required ? " · required" : ""}
            </span>
          )}
          {isRemoved && (
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              no longer in template
            </span>
          )}
        </button>
        {isRemoved && (
          <button
            onClick={onRemove}
            style={{
              ...btnBase,
              padding: "2px 8px",
              fontSize: 11,
              color: "var(--danger-color)",
              background: "none",
            }}
          >
            Remove
          </button>
        )}
      </div>

      {!isRemoved && open && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
            padding: "0 10px 12px",
          }}
        >
          <div>
            <label style={labelStyle}>Label</label>
            <input
              style={inputStyle}
              value={v.label}
              onChange={(e) => onUpdate({ label: e.target.value })}
              placeholder={titleCase(v.name)}
            />
          </div>
          <div>
            <label style={labelStyle}>Type</label>
            <select
              style={selectStyle}
              value={v.type}
              onChange={(e) =>
                onUpdate({ type: e.target.value as SkillVariable["type"] })
              }
            >
              {VARIABLE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Placeholder</label>
            <input
              style={inputStyle}
              value={v.placeholder ?? ""}
              onChange={(e) => onUpdate({ placeholder: e.target.value })}
            />
          </div>
          <div>
            <label style={labelStyle}>Default Value</label>
            <input
              style={inputStyle}
              value={v.defaultValue ?? ""}
              onChange={(e) => onUpdate({ defaultValue: e.target.value })}
            />
          </div>
          <div
            style={{
              gridColumn: "1 / -1",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                color: "var(--text-secondary)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={v.required ?? false}
                onChange={(e) => onUpdate({ required: e.target.checked })}
              />
              Required
            </label>
          </div>

          {v.type === "select" && (
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={labelStyle}>Options</label>
              <div
                style={{ display: "flex", flexDirection: "column", gap: 6 }}
              >
                {(v.options ?? []).map((opt, oi) => (
                  <div
                    key={oi}
                    style={{ display: "flex", gap: 6, alignItems: "center" }}
                  >
                    <input
                      style={{ ...inputStyle, flex: 1 }}
                      value={opt.value}
                      onChange={(e) =>
                        onUpdateOption(oi, "value", e.target.value)
                      }
                      placeholder="value"
                    />
                    <input
                      style={{ ...inputStyle, flex: 1 }}
                      value={opt.label}
                      onChange={(e) =>
                        onUpdateOption(oi, "label", e.target.value)
                      }
                      placeholder="label"
                    />
                    <button
                      onClick={() => onRemoveOption(oi)}
                      style={{
                        background: "none",
                        border: "none",
                        color: "var(--text-muted)",
                        cursor: "pointer",
                        fontSize: 16,
                        padding: "0 4px",
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  onClick={onAddOption}
                  style={{
                    ...btnBase,
                    background: "none",
                    color: "var(--text-secondary)",
                    fontSize: 11,
                    alignSelf: "flex-start",
                  }}
                >
                  + Add option
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SkillEditor({ skill, onSave, onClose }: SkillEditorProps) {
  const isEditing = skill !== null;

  const [name, setName] = useState(skill?.name ?? "");
  const [icon, setIcon] = useState(skill?.icon ?? "⚡");
  const [category, setCategory] = useState<SkillTemplate["category"]>(
    skill?.category ?? "general",
  );
  const [accentColor, setAccentColor] = useState(
    skill?.accentColor ?? "var(--info-color)",
  );
  const [description, setDescription] = useState(skill?.description ?? "");
  const [template, setTemplate] = useState(skill?.template ?? "");
  const [variables, setVariables] = useState<SkillVariable[]>(
    skill?.variables ?? [],
  );
  const [subskills, setSubskills] = useState<SubSkill[]>(
    skill?.subskills ?? [],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Which category the rail currently has selected. Editing always opens on
  // Essentials — every panel stays mounted so nothing is lost when switching.
  const [activeCategory, setActiveCategory] =
    useState<EditorCategory>("essentials");

  // Extract variable names from template
  const detectedNames = useMemo(() => extractVariableNames(template), [template]);

  // Determine which variables are still in template vs removed
  const activeVarNames = useMemo(() => new Set(detectedNames), [detectedNames]);

  // Auto-sync variables with detected names
  const syncedVariables = useMemo(() => {
    const varMap = new Map(variables.map((v) => [v.name, v]));
    const result: (SkillVariable & { _removed?: boolean })[] = [];

    // Add all detected variables in order
    for (const n of detectedNames) {
      result.push(varMap.get(n) ?? emptyVariable(n));
    }

    // Add removed variables (in variables list but no longer in template)
    for (const v of variables) {
      if (!activeVarNames.has(v.name)) {
        result.push({ ...v, _removed: true });
      }
    }

    return result;
  }, [detectedNames, variables, activeVarNames]);

  const activeVarCount = useMemo(
    () => syncedVariables.filter((v) => !v._removed).length,
    [syncedVariables],
  );
  const namedSubskillCount = useMemo(
    () => subskills.filter((s) => s.name.trim()).length,
    [subskills],
  );

  const updateVariable = useCallback(
    (varName: string, updates: Partial<SkillVariable>) => {
      setVariables((prev) => {
        const idx = prev.findIndex((v) => v.name === varName);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = { ...next[idx]!, ...updates };
          return next;
        }
        return [...prev, { ...emptyVariable(varName), ...updates }];
      });
    },
    [],
  );

  const removeVariable = useCallback((varName: string) => {
    setVariables((prev) => prev.filter((v) => v.name !== varName));
  }, []);

  const addOption = useCallback((varName: string) => {
    setVariables((prev) => {
      const idx = prev.findIndex((v) => v.name === varName);
      if (idx < 0) return prev;
      const next = [...prev];
      const v = { ...next[idx]! };
      v.options = [...(v.options ?? []), { value: "", label: "" }];
      next[idx] = v;
      return next;
    });
  }, []);

  const updateOption = useCallback(
    (varName: string, optIdx: number, field: "value" | "label", val: string) => {
      setVariables((prev) => {
        const idx = prev.findIndex((v) => v.name === varName);
        if (idx < 0) return prev;
        const next = [...prev];
        const v = { ...next[idx]! };
        const opts = [...(v.options ?? [])];
        opts[optIdx] = { ...opts[optIdx]!, [field]: val };
        v.options = opts;
        next[idx] = v;
        return next;
      });
    },
    [],
  );

  const removeOption = useCallback((varName: string, optIdx: number) => {
    setVariables((prev) => {
      const idx = prev.findIndex((v) => v.name === varName);
      if (idx < 0) return prev;
      const next = [...prev];
      const v = { ...next[idx]! };
      const opts = [...(v.options ?? [])];
      opts.splice(optIdx, 1);
      v.options = opts;
      next[idx] = v;
      return next;
    });
  }, []);

  // Build a SkillTemplate from current form state. Shared by save + preview so
  // the live preview reflects exactly what would be persisted.
  const buildSkill = useCallback((): SkillTemplate => {
    const finalVars = syncedVariables
      .filter((v) => !("_removed" in v && v._removed))
      .map(({ _removed: _, ...v }) => v as SkillVariable);

    return {
      id: isEditing ? skill.id : generateId(name) || "skill",
      name: name.trim() || "Skill",
      description: description.trim(),
      category,
      icon,
      accentColor,
      template,
      variables: finalVars,
      // Persist only sub-skills that have a name (drops empty scaffolds).
      ...(subskills.some((s) => s.name.trim())
        ? { subskills: subskills.filter((s) => s.name.trim()) }
        : {}),
    };
  }, [
    syncedVariables,
    isEditing,
    skill,
    name,
    description,
    category,
    icon,
    accentColor,
    template,
    subskills,
  ]);

  // Compile the template with each variable's default value so the editor can
  // show the exact markdown that gets injected into the system prompt.
  const compiledPreview = useMemo(() => {
    const previewSkill = buildSkill();
    const values: Record<string, string> = {};
    for (const v of previewSkill.variables) {
      if (v.defaultValue) values[v.name] = v.defaultValue;
    }
    const compiled = compileSkillTemplate(previewSkill, values);
    const map = buildSubskillMap(previewSkill);
    return map ? `${compiled}\n\n${map}` : compiled;
  }, [buildSkill]);

  // Live validation surfaced in the preview pane (in addition to inline errors).
  const validationIssues = useMemo(() => {
    const issues: string[] = [];
    if (!name.trim()) issues.push("Name is required");
    if (!template.trim()) issues.push("Template is required");
    return issues;
  }, [name, template]);

  const essentialsStatus: "ok" | "warn" =
    validationIssues.length === 0 ? "ok" : "warn";

  const handleSave = () => {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs["name"] = "Name is required";
    if (!template.trim()) errs["template"] = "Template is required";
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      // Surface the offending fields by jumping to Essentials.
      setActiveCategory("essentials");
      return;
    }
    setErrors({});
    onSave(buildSkill());
  };

  // Only the active category's panel is visible; the rest stay mounted (hidden)
  // so form state and focus survive navigation.
  const panelStyle = (cat: EditorCategory): React.CSSProperties => ({
    display: activeCategory === cat ? "block" : "none",
  });

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div
        style={modalStyle}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={headerStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 20 }}>{icon}</span>
            <div>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
                {isEditing ? "Edit Skill" : "New Skill"}
              </h2>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                {isEditing ? skill.id : "project skill"}
              </div>
            </div>
          </div>
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

        <div style={bodyRowStyle}>
          <nav style={railStyle} aria-label="Skill sections">
            <div
              style={{
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                letterSpacing: 0.6,
                textTransform: "uppercase",
                color: "var(--text-muted)",
                padding: "4px 8px 8px",
              }}
            >
              Sections
            </div>
            <RailItem
              title="Essentials"
              sublabel="Name, body"
              glyph="✦"
              active={activeCategory === "essentials"}
              status={essentialsStatus}
              onClick={() => setActiveCategory("essentials")}
            />
            <RailItem
              title="Appearance"
              sublabel="Icon, accent"
              glyph="🎨"
              active={activeCategory === "appearance"}
              onClick={() => setActiveCategory("appearance")}
            />
            <RailItem
              title="Variables"
              sublabel="Placeholders"
              glyph="⌘"
              active={activeCategory === "variables"}
              badge={activeVarCount}
              onClick={() => setActiveCategory("variables")}
            />
            <RailItem
              title="Sub-skills"
              sublabel="Nested map"
              glyph="▸"
              active={activeCategory === "subskills"}
              badge={namedSubskillCount}
              onClick={() => setActiveCategory("subskills")}
            />
            <div
              style={{
                marginTop: "auto",
                padding: 8,
                fontSize: 11,
                color: "var(--text-muted)",
                lineHeight: 1.5,
              }}
            >
              Every section stays a click away — the preview on the right updates
              as you edit.
            </div>
          </nav>

          <div style={formPaneStyle}>
            <div style={panelStyle("essentials")}>
              <h3 style={panelTitleStyle}>Essentials</h3>
              <p style={panelHintStyle}>
                The identity and body of the skill. Required to save.
              </p>
              <div style={{ marginBottom: 12 }}>
                <label style={labelStyle}>Name *</label>
                <input
                  style={{
                    ...inputStyle,
                    borderColor: errors["name"]
                      ? "var(--danger-color)"
                      : "var(--border-default)",
                  }}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Skill"
                />
                {errors["name"] && (
                  <div style={{ color: "var(--danger-color)", fontSize: 11, marginTop: 2 }}>
                    {errors["name"]}
                  </div>
                )}
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={labelStyle}>Description</label>
                <input
                  style={inputStyle}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Brief description of what this skill does"
                />
              </div>
              <div>
                <label style={labelStyle}>Template *</label>
                <textarea
                  style={{
                    ...inputStyle,
                    fontFamily: "var(--font-mono)",
                    minHeight: 200,
                    resize: "vertical",
                    lineHeight: 1.5,
                    borderColor: errors["template"]
                      ? "var(--danger-color)"
                      : "var(--border-default)",
                  }}
                  value={template}
                  onChange={(e) => setTemplate(e.target.value)}
                  placeholder={"# My Skill\n\nInstructions here...\n\nFocus on: {{focus_area}}"}
                />
                {errors["template"] && (
                  <div style={{ color: "var(--danger-color)", fontSize: 11, marginTop: 2 }}>
                    {errors["template"]}
                  </div>
                )}
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
                  Use {"{{variable_name}}"} for placeholders
                </div>
                {detectedNames.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                    <span style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: "22px" }}>
                      Detected variables:
                    </span>
                    {detectedNames.map((n) => (
                      <span
                        key={n}
                        style={{
                          display: "inline-block",
                          padding: "2px 8px",
                          background: "var(--bg-elevated)",
                          border: "1px solid var(--border-default)",
                          borderRadius: 12,
                          fontSize: 11,
                          color: "var(--accent)",
                          fontFamily: "var(--font-mono)",
                        }}
                      >
                        {n}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div style={panelStyle("appearance")}>
              <h3 style={panelTitleStyle}>Appearance</h3>
              <p style={panelHintStyle}>
                How this skill reads in the launcher.
              </p>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "88px 1fr 1fr",
                  gap: 12,
                }}
              >
                <div>
                  <label style={labelStyle}>Icon</label>
                  <input
                    style={{ ...inputStyle, textAlign: "center" }}
                    value={icon}
                    onChange={(e) => setIcon(e.target.value)}
                    maxLength={4}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Category</label>
                  <select
                    style={selectStyle}
                    value={category}
                    onChange={(e) =>
                      setCategory(e.target.value as SkillTemplate["category"])
                    }
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c.charAt(0).toUpperCase() + c.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Accent Color</label>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                      type="color"
                      value={accentColor}
                      onChange={(e) => setAccentColor(e.target.value)}
                      style={{
                        width: 32,
                        height: 32,
                        padding: 0,
                        border: "1px solid var(--border-default)",
                        borderRadius: 6,
                        background: "none",
                        cursor: "pointer",
                        flexShrink: 0,
                      }}
                    />
                    <input
                      style={{ ...inputStyle, flex: 1, minWidth: 0 }}
                      value={accentColor}
                      onChange={(e) => setAccentColor(e.target.value)}
                      placeholder="#3b82f6"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div style={panelStyle("variables")}>
              <h3 style={panelTitleStyle}>Variables</h3>
              <p style={panelHintStyle}>
                Auto-synced from {"{{placeholders}}"} in the template. Click a row
                to configure its label, type, default, and options.
              </p>
              {syncedVariables.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  No variables yet. Add a {"{{placeholder}}"} to the template and
                  it appears here.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {syncedVariables.map((v) => (
                    <VariableRow
                      key={v.name}
                      v={v}
                      isRemoved={Boolean(v._removed)}
                      onUpdate={(updates) => updateVariable(v.name, updates)}
                      onRemove={() => removeVariable(v.name)}
                      onAddOption={() => addOption(v.name)}
                      onUpdateOption={(oi, field, val) =>
                        updateOption(v.name, oi, field, val)
                      }
                      onRemoveOption={(oi) => removeOption(v.name, oi)}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Sub-skills — note: the rail label is the canonical "Sub-skills"
                heading, so this panel intentionally has no duplicate title. */}
            <div style={panelStyle("subskills")}>
              <h3 style={panelTitleStyle}>Sub-skill map</h3>
              <p style={{ ...panelHintStyle, marginTop: 0 }}>
                Turn this skill into a map. Each sub-skill's name + description is
                always injected; its body is pulled on demand via{" "}
                <code>load_subskill</code> unless “Always include” is checked.
              </p>
              <SkillSubskillEditor subskills={subskills} onChange={setSubskills} />
            </div>
          </div>

          <div style={previewPaneStyle}>
            <div
              style={{
                padding: "14px 16px 10px",
                borderBottom: "1px solid var(--border-default)",
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                }}
              >
                Compiled preview
                <span
                  style={{
                    fontSize: 9,
                    fontFamily: "var(--font-mono)",
                    color: "var(--status-success, #34d399)",
                    border:
                      "1px solid color-mix(in srgb, var(--status-success, #34d399) 40%, var(--border-default))",
                    borderRadius: 10,
                    padding: "0 7px",
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                  }}
                >
                  live
                </span>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                Exactly what gets injected into the prompt
              </div>
            </div>

            {validationIssues.length > 0 && (
              <div
                style={{
                  padding: "10px 16px",
                  borderBottom: "1px solid var(--border-default)",
                  background: "var(--bg-secondary)",
                  flexShrink: 0,
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--danger-color)",
                    marginBottom: 4,
                  }}
                >
                  Before saving
                </div>
                <ul
                  style={{
                    margin: 0,
                    paddingLeft: 16,
                    fontSize: 11,
                    color: "var(--text-secondary)",
                    lineHeight: 1.6,
                  }}
                >
                  {validationIssues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
            )}

            <pre
              style={{
                margin: 0,
                padding: 16,
                flex: 1,
                minHeight: 0,
                overflow: "auto",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                lineHeight: 1.5,
                color: "var(--text-secondary)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {compiledPreview || "(empty — add template content on the left)"}
            </pre>
          </div>
        </div>

        <div style={footerStyle}>
          <span
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              display: "flex",
              alignItems: "center",
              gap: 7,
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background:
                  essentialsStatus === "ok"
                    ? "var(--status-success, #34d399)"
                    : "var(--status-warning, #fbbf24)",
              }}
            />
            {essentialsStatus === "ok"
              ? `Ready to save · ${activeVarCount} variable${activeVarCount === 1 ? "" : "s"} · ${namedSubskillCount} sub-skill${namedSubskillCount === 1 ? "" : "s"}`
              : "Complete the required fields in Essentials"}
          </span>
          <div style={{ flex: 1 }} />
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
            onClick={handleSave}
            style={{
              ...btnBase,
              background: "var(--accent)",
              color: "white",
              border: "1px solid var(--accent)",
              fontWeight: 600,
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
