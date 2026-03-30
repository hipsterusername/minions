import { useState, useMemo, useCallback } from "react";
import type { SkillTemplate, SkillVariable } from "./skills/types.ts";
import { extractVariableNames } from "./skills/types.ts";

interface SkillEditorProps {
  /** Existing skill to edit, or null for creating a new one */
  skill: SkillTemplate | null;
  /** Called when user saves. Receives the complete SkillTemplate. */
  onSave: (skill: SkillTemplate) => void;
  /** Called when user cancels */
  onClose: () => void;
}

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
  background: "rgba(0,0,0,0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 9999,
};

const modalStyle: React.CSSProperties = {
  width: 560,
  maxHeight: "90vh",
  overflow: "auto",
  background: "var(--bg-secondary)",
  border: "1px solid var(--border-default)",
  borderRadius: 8,
  fontFamily: "var(--font-sans)",
  color: "var(--text-primary)",
  display: "flex",
  flexDirection: "column",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "16px 20px",
  borderBottom: "1px solid var(--border-default)",
};

const sectionStyle: React.CSSProperties = {
  padding: "16px 20px",
  borderBottom: "1px solid var(--border-default)",
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
  justifyContent: "flex-end",
  gap: 8,
  padding: "16px 20px",
};

const btnBase: React.CSSProperties = {
  padding: "8px 16px",
  borderRadius: 6,
  border: "1px solid var(--border-default)",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: "var(--font-sans)",
};

function emptyVariable(name: string): SkillVariable {
  return {
    name,
    label: titleCase(name),
    type: "text",
    required: false,
  };
}

export function SkillEditor({ skill, onSave, onClose }: SkillEditorProps) {
  const isEditing = skill !== null;

  const [name, setName] = useState(skill?.name ?? "");
  const [icon, setIcon] = useState(skill?.icon ?? "⚡");
  const [category, setCategory] = useState<SkillTemplate["category"]>(
    skill?.category ?? "general",
  );
  const [accentColor, setAccentColor] = useState(
    skill?.accentColor ?? "#3b82f6",
  );
  const [description, setDescription] = useState(skill?.description ?? "");
  const [template, setTemplate] = useState(skill?.template ?? "");
  const [variables, setVariables] = useState<SkillVariable[]>(
    skill?.variables ?? [],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

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

  const addOption = useCallback(
    (varName: string) => {
      setVariables((prev) => {
        const idx = prev.findIndex((v) => v.name === varName);
        if (idx < 0) return prev;
        const next = [...prev];
        const v = { ...next[idx]! };
        v.options = [...(v.options ?? []), { value: "", label: "" }];
        next[idx] = v;
        return next;
      });
    },
    [],
  );

  const updateOption = useCallback(
    (
      varName: string,
      optIdx: number,
      field: "value" | "label",
      val: string,
    ) => {
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

  const removeOption = useCallback(
    (varName: string, optIdx: number) => {
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
    },
    [],
  );

  const handleSave = () => {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = "Name is required";
    if (!template.trim()) errs.template = "Template is required";
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    setErrors({});

    // Build final variables list (only active ones)
    const finalVars = syncedVariables
      .filter((v) => !("_removed" in v && v._removed))
      .map(({ _removed: _, ...v }) => v as SkillVariable);

    const result: SkillTemplate = {
      id: isEditing ? skill.id : generateId(name),
      name: name.trim(),
      description: description.trim(),
      category,
      icon,
      accentColor,
      template,
      variables: finalVars,
    };

    onSave(result);
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div
        style={modalStyle}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={headerStyle}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {isEditing ? "Edit Skill" : "New Skill"}
          </h2>
          <button
            onClick={onClose}
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

        {/* Metadata Section */}
        <div style={sectionStyle}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 60px",
              gap: 12,
              marginBottom: 12,
            }}
          >
            <div>
              <label style={labelStyle}>Name *</label>
              <input
                style={{
                  ...inputStyle,
                  borderColor: errors.name
                    ? "#ef4444"
                    : "var(--border-default)",
                }}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Skill"
              />
              {errors.name && (
                <div style={{ color: "#ef4444", fontSize: 11, marginTop: 2 }}>
                  {errors.name}
                </div>
              )}
            </div>
            <div>
              <label style={labelStyle}>Icon</label>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  style={{ ...inputStyle, width: 40, textAlign: "center" }}
                  value={icon}
                  onChange={(e) => setIcon(e.target.value)}
                  maxLength={4}
                />
                <span style={{ fontSize: 20 }}>{icon}</span>
              </div>
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
              marginBottom: 12,
            }}
          >
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
                  }}
                />
                <input
                  style={{ ...inputStyle, flex: 1 }}
                  value={accentColor}
                  onChange={(e) => setAccentColor(e.target.value)}
                  placeholder="#3b82f6"
                />
              </div>
            </div>
          </div>

          <div>
            <label style={labelStyle}>Description</label>
            <input
              style={inputStyle}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description of what this skill does"
            />
          </div>
        </div>

        {/* Template Editor Section */}
        <div style={sectionStyle}>
          <label style={labelStyle}>Template *</label>
          <textarea
            style={{
              ...inputStyle,
              fontFamily: "var(--font-mono)",
              minHeight: 160,
              resize: "vertical",
              lineHeight: 1.5,
              borderColor: errors.template
                ? "#ef4444"
                : "var(--border-default)",
            }}
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            placeholder={"# My Skill\n\nInstructions here...\n\nFocus on: {{focus_area}}"}
          />
          {errors.template && (
            <div style={{ color: "#ef4444", fontSize: 11, marginTop: 2 }}>
              {errors.template}
            </div>
          )}
          <div
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              marginTop: 6,
            }}
          >
            Use {"{{variable_name}}"} for placeholders
          </div>

          {detectedNames.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                marginTop: 8,
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  lineHeight: "22px",
                }}
              >
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

        {/* Variables Section */}
        {syncedVariables.length > 0 && (
          <div style={sectionStyle}>
            <label
              style={{
                ...labelStyle,
                fontSize: 13,
                fontWeight: 600,
                color: "var(--text-primary)",
                marginBottom: 12,
              }}
            >
              Variables
            </label>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {syncedVariables.map((v) => {
                const isRemoved = "_removed" in v && v._removed;
                return (
                  <div
                    key={v.name}
                    style={{
                      padding: 12,
                      background: "var(--bg-primary)",
                      border: "1px solid var(--border-default)",
                      borderRadius: 6,
                      opacity: isRemoved ? 0.5 : 1,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: 8,
                      }}
                    >
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 13,
                          color: "var(--accent)",
                          fontWeight: 600,
                        }}
                      >
                        {`{{${v.name}}}`}
                      </span>
                      {isRemoved && (
                        <button
                          onClick={() => removeVariable(v.name)}
                          style={{
                            ...btnBase,
                            padding: "2px 8px",
                            fontSize: 11,
                            color: "#ef4444",
                            background: "none",
                          }}
                        >
                          Remove
                        </button>
                      )}
                    </div>

                    {!isRemoved && (
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "1fr 1fr",
                          gap: 8,
                        }}
                      >
                        <div>
                          <label style={labelStyle}>Label</label>
                          <input
                            style={inputStyle}
                            value={v.label}
                            onChange={(e) =>
                              updateVariable(v.name, { label: e.target.value })
                            }
                            placeholder={titleCase(v.name)}
                          />
                        </div>
                        <div>
                          <label style={labelStyle}>Type</label>
                          <select
                            style={selectStyle}
                            value={v.type}
                            onChange={(e) =>
                              updateVariable(v.name, {
                                type: e.target.value as SkillVariable["type"],
                              })
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
                            onChange={(e) =>
                              updateVariable(v.name, {
                                placeholder: e.target.value,
                              })
                            }
                          />
                        </div>
                        <div>
                          <label style={labelStyle}>Default Value</label>
                          <input
                            style={inputStyle}
                            value={v.defaultValue ?? ""}
                            onChange={(e) =>
                              updateVariable(v.name, {
                                defaultValue: e.target.value,
                              })
                            }
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
                              onChange={(e) =>
                                updateVariable(v.name, {
                                  required: e.target.checked,
                                })
                              }
                            />
                            Required
                          </label>
                        </div>

                        {/* Select options */}
                        {v.type === "select" && (
                          <div style={{ gridColumn: "1 / -1" }}>
                            <label style={labelStyle}>Options</label>
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: 6,
                              }}
                            >
                              {(v.options ?? []).map((opt, oi) => (
                                <div
                                  key={oi}
                                  style={{
                                    display: "flex",
                                    gap: 6,
                                    alignItems: "center",
                                  }}
                                >
                                  <input
                                    style={{ ...inputStyle, flex: 1 }}
                                    value={opt.value}
                                    onChange={(e) =>
                                      updateOption(
                                        v.name,
                                        oi,
                                        "value",
                                        e.target.value,
                                      )
                                    }
                                    placeholder="value"
                                  />
                                  <input
                                    style={{ ...inputStyle, flex: 1 }}
                                    value={opt.label}
                                    onChange={(e) =>
                                      updateOption(
                                        v.name,
                                        oi,
                                        "label",
                                        e.target.value,
                                      )
                                    }
                                    placeholder="label"
                                  />
                                  <button
                                    onClick={() => removeOption(v.name, oi)}
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
                                onClick={() => addOption(v.name)}
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
              })}
            </div>
          </div>
        )}

        {/* Footer */}
        <div style={footerStyle}>
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
