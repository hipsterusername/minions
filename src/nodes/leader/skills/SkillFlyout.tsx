import { useLayoutEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { getPickableSkills, getSkill } from "../../../skills/registry.ts";
import type { SkillTemplate } from "../../../skills/types.ts";
import { SkillTagChip } from "./SkillTagChip.tsx";
import { SkillVariableInputs } from "./SkillVariableInputs.tsx";

/**
 * A floating split-panel modal anchored to a trigger
 * button. Left panel browses available skills by category; right panel
 * configures the currently armed skills and their variable values.
 *
 * Portaled to `document.body` to escape any ancestor `overflow:hidden`
 * containers (the leader node's chrome).
 */

const SKILL_CATEGORIES: { key: string; label: string }[] = [
  { key: "code", label: "Code" },
  { key: "docs", label: "Docs" },
  { key: "testing", label: "Testing" },
  { key: "devops", label: "DevOps" },
  { key: "analysis", label: "Analysis" },
  { key: "design", label: "Design" },
  { key: "general", label: "General" },
];

const FLYOUT_W = 680;
const FLYOUT_H = 480;
const FLYOUT_GAP = 6; // px below anchor
const VIEWPORT_GAP = 8;

export function SkillFlyout({
  skillIds,
  skillValues,
  open,
  readOnly,
  anchorRef,
  onUpdate,
  onClose,
}: {
  skillIds: string[];
  skillValues: Record<string, Record<string, string>>;
  open: boolean;
  readOnly: boolean;
  anchorRef?: RefObject<HTMLElement | null>;
  onUpdate: (patch: {
    skillIds?: string[];
    skillValues?: Record<string, Record<string, string>>;
    skillPanelOpen?: boolean;
  }) => void;
  onClose: () => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [layout, setLayout] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
    compact: boolean;
  } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setLayout(null);
      return;
    }
    const positionFlyout = () => {
      const rect = anchorRef?.current?.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const compact = vw < 720;
      const width = compact ? vw : Math.min(FLYOUT_W, vw - VIEWPORT_GAP * 2);
      const height = compact
        ? Math.min(620, Math.max(320, vh - VIEWPORT_GAP))
        : Math.min(FLYOUT_H, vh - VIEWPORT_GAP * 2);

      if (compact || !rect) {
        setLayout({ top: vh - height, left: 0, width, height, compact });
        return;
      }

      let top = rect.bottom + FLYOUT_GAP;
      if (top + height > vh - VIEWPORT_GAP) top = rect.top - height - FLYOUT_GAP;
      top = Math.max(VIEWPORT_GAP, Math.min(top, vh - height - VIEWPORT_GAP));
      const left = Math.max(
        VIEWPORT_GAP,
        Math.min(rect.left, vw - width - VIEWPORT_GAP),
      );
      setLayout({ top, left, width, height, compact });
    };

    positionFlyout();
    window.addEventListener("resize", positionFlyout);
    return () => window.removeEventListener("resize", positionFlyout);
  }, [open, anchorRef]);

  const allSkills = getPickableSkills();
  const taggedSkills = skillIds
    .map((id) => getSkill(id))
    .filter((s): s is SkillTemplate => s !== undefined);

  const handleAddSkill = (id: string) => {
    if (!skillIds.includes(id)) {
      onUpdate({ skillIds: [...skillIds, id], skillPanelOpen: true });
    }
  };

  const handleRemoveSkill = (id: string) => {
    const next = skillIds.filter((s) => s !== id);
    const nextValues = { ...skillValues };
    delete nextValues[id];
    onUpdate({ skillIds: next, skillValues: nextValues });
  };

  const handleVarChange = (skillId: string, varName: string, value: string) => {
    const current = skillValues[skillId] ?? {};
    onUpdate({
      skillValues: { ...skillValues, [skillId]: { ...current, [varName]: value } },
    });
  };

  // Filter available skills by search + category (show all when readOnly)
  const query = searchQuery.toLowerCase().trim();
  const browseByCategory = SKILL_CATEGORIES.map((cat) => ({
    ...cat,
    skills: allSkills.filter(
      (s) =>
        s.category === cat.key &&
        (readOnly ? skillIds.includes(s.id) : !skillIds.includes(s.id)) &&
        (query === "" ||
          s.name.toLowerCase().includes(query) ||
          s.description.toLowerCase().includes(query)),
    ),
  })).filter((cat) => cat.skills.length > 0);

  if (!open) return null;

  const flyoutContent = (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 9998 }} />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Choose skills"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: "fixed",
          top: layout?.top ?? VIEWPORT_GAP,
          left: layout?.left ?? VIEWPORT_GAP,
          zIndex: 9999,
          width: layout?.width ?? `calc(100vw - ${VIEWPORT_GAP * 2}px)`,
          height: layout?.height ?? `calc(100vh - ${VIEWPORT_GAP * 2}px)`,
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-default)",
          borderRadius: layout?.compact ? "14px 14px 0 0" : 10,
          boxShadow: "var(--shadow-lg)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "10px 14px",
            borderBottom: "1px solid var(--border-default)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "var(--bg-primary)",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 14 }}>⚡</span>
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--text-primary)",
                fontFamily: "var(--font-mono)",
              }}
            >
              Skills
            </span>
            {taggedSkills.length > 0 && (
              <span
                style={{
                  fontSize: 10,
                  fontFamily: "var(--font-mono)",
                  padding: "1px 6px",
                  borderRadius: 10,
                  background: "var(--state-active)",
                  color: "var(--accent)",
                  border: "1px solid var(--accent)",
                }}
              >
                {taggedSkills.length} active
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 16,
              padding: "0 2px",
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        <div style={{
          flex: 1,
          display: "flex",
          flexDirection: layout?.compact ? "column" : "row",
          minHeight: 0,
        }}>
          <div
            style={{
              width: layout?.compact ? "100%" : 220,
              height: layout?.compact ? "42%" : "auto",
              flexShrink: 0,
              borderRight: layout?.compact ? "none" : "1px solid var(--border-default)",
              borderBottom: layout?.compact ? "1px solid var(--border-default)" : "none",
              display: "flex",
              flexDirection: "column",
              background: "var(--bg-primary)",
            }}
          >
            <div
              style={{
                padding: "8px 10px",
                borderBottom: "1px solid var(--border-default)",
                flexShrink: 0,
              }}
            >
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
                placeholder="Search skills…"
                style={{
                  width: "100%",
                  padding: "5px 8px",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 5,
                  color: "var(--text-primary)",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>

            <div
              style={{
                flex: 1,
                overflowY: "auto",
                minHeight: 0,
                padding: "4px 6px 8px",
              }}
            >
              {browseByCategory.length === 0 && (
                <div
                  style={{
                    padding: "16px 8px",
                    fontSize: 11,
                    color: "var(--text-muted)",
                    textAlign: "center",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {query ? "No matches" : readOnly ? "No skills" : "All added ✓"}
                </div>
              )}
              {browseByCategory.map((cat) => (
                <div key={cat.key}>
                  <div
                    style={{
                      fontSize: 9,
                      fontFamily: "var(--font-mono)",
                      color: "var(--text-muted)",
                      padding: "8px 6px 3px",
                      textTransform: "uppercase",
                      letterSpacing: 0.6,
                    }}
                  >
                    {cat.label}
                  </div>
                  {cat.skills.map((skill) => (
                    <button
                      key={skill.id}
                      onClick={() => !readOnly && handleAddSkill(skill.id)}
                      onMouseDown={(e) => e.stopPropagation()}
                      disabled={readOnly}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 7,
                        width: "100%",
                        padding: "6px 6px",
                        background: "transparent",
                        border: "none",
                        borderRadius: 5,
                        color: "var(--text-primary)",
                        fontSize: 11,
                        cursor: readOnly ? "default" : "pointer",
                        textAlign: "left",
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={(e) => {
                        if (!readOnly)
                          e.currentTarget.style.background = "var(--bg-elevated)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <span
                        style={{ fontSize: 13, lineHeight: 1.3, flexShrink: 0 }}
                      >
                        {skill.icon}
                      </span>
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 1,
                          minWidth: 0,
                        }}
                      >
                        <span
                          style={{
                            fontWeight: 500,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {skill.name}
                        </span>
                        <span
                          style={{
                            fontSize: 10,
                            color: "var(--text-muted)",
                            lineHeight: 1.3,
                          }}
                        >
                          {skill.description.length > 55
                            ? skill.description.slice(0, 55) + "…"
                            : skill.description}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              minWidth: 0,
            }}
          >
            <div
              style={{
                position: "relative",
                borderBottom: "1px solid var(--border-default)",
                flexShrink: 0,
                background: "var(--state-hover)",
              }}
            >
              <div
                style={{
                  padding: "6px 12px",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  flexWrap: "nowrap",
                  overflowX: "auto",
                  scrollbarWidth: "none",
                  msOverflowStyle: "none",
                  minHeight: 38,
                }}
              >
                {taggedSkills.length === 0 ? (
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted)",
                      fontFamily: "var(--font-mono)",
                      fontStyle: "italic",
                      whiteSpace: "nowrap",
                    }}
                  >
                    No skills selected — pick from the left panel
                  </span>
                ) : (
                  taggedSkills.map((skill) => (
                    <SkillTagChip
                      key={skill.id}
                      skill={skill}
                      readOnly={readOnly}
                      onRemove={() => handleRemoveSkill(skill.id)}
                    />
                  ))
                )}
              </div>
              {taggedSkills.length > 0 && (
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    right: 0,
                    bottom: 0,
                    width: 32,
                    background:
                      "linear-gradient(to right, transparent, var(--state-hover))",
                    pointerEvents: "none",
                  }}
                />
              )}
            </div>

            <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  overflowY: "auto",
                  padding: "12px 16px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 16,
                }}
              >
                {taggedSkills.length === 0 && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      height: "100%",
                      gap: 10,
                      color: "var(--text-muted)",
                    }}
                  >
                    <span style={{ fontSize: 32, opacity: 0.3 }}>⚡</span>
                    <span style={{ fontSize: 12, fontFamily: "var(--font-mono)" }}>
                      Add skills to configure them here
                    </span>
                  </div>
                )}
                {taggedSkills.map((skill) => (
                  <div
                    key={skill.id}
                    style={{
                      background: "var(--bg-primary)",
                      border: `1px solid ${skill.accentColor}30`,
                      borderRadius: 7,
                      overflow: "hidden",
                      flexShrink: 0,
                    }}
                  >
                    <div
                      style={{
                        padding: "8px 12px",
                        borderBottom: `1px solid ${skill.accentColor}20`,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        background: `${skill.accentColor}10`,
                      }}
                    >
                      <span style={{ fontSize: 15 }}>{skill.icon}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            color: skill.accentColor,
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          {skill.name}
                        </div>
                        <div
                          style={{
                            fontSize: 10,
                            color: "var(--text-muted)",
                            marginTop: 1,
                          }}
                        >
                          {skill.description}
                        </div>
                      </div>
                      {!readOnly && (
                        <button
                          onClick={() => handleRemoveSkill(skill.id)}
                          onMouseDown={(e) => e.stopPropagation()}
                          style={{
                            background: "none",
                            border: "none",
                            color: "var(--text-muted)",
                            cursor: "pointer",
                            fontSize: 12,
                            padding: "2px 4px",
                            borderRadius: 3,
                            lineHeight: 1,
                            flexShrink: 0,
                          }}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    {skill.variables.length === 0 ? (
                      <div
                        style={{
                          padding: "10px 12px",
                          fontSize: 11,
                          color: "var(--text-muted)",
                          fontStyle: "italic",
                        }}
                      >
                        No configuration needed.
                      </div>
                    ) : (
                      <div style={{ padding: "10px 12px" }}>
                        <SkillVariableInputs
                          skill={skill}
                          values={skillValues[skill.id] ?? {}}
                          onChange={(varName, value) =>
                            handleVarChange(skill.id, varName, value)
                          }
                          readOnly={readOnly}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div
                style={{
                  position: "absolute",
                  bottom: 0,
                  left: 0,
                  right: 0,
                  height: 28,
                  background:
                    "linear-gradient(to bottom, transparent, var(--bg-secondary))",
                  pointerEvents: "none",
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </>
  );

  return createPortal(flyoutContent, document.body);
}
