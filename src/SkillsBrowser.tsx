import { useState, useMemo } from "react";
import { getAllSkills } from "./skills/registry.ts";
import type { SkillTemplate } from "./skills/types.ts";

interface SkillsBrowserProps {
  onLaunchSkill: (skillId: string) => void;
  onCreateSkill: () => void;
  onEditSkill: (skill: SkillTemplate) => void;
  onDeleteSkill: (skillId: string) => void;
  onImportSkills: () => void;
  onExportSkills: () => void;
  refreshKey?: number;
}

const CATEGORY_LABELS: Record<string, string> = {
  code: "Code",
  docs: "Docs",
  testing: "Testing",
  devops: "DevOps",
  analysis: "Analysis",
  design: "Design",
  general: "General",
};

const actionButtonStyle: React.CSSProperties = {
  fontSize: 14,
  padding: "2px 4px",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  color: "var(--text-muted)",
  width: 20,
  height: 20,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 3,
  lineHeight: 1,
};

export function SkillsBrowser({
  onLaunchSkill,
  onCreateSkill,
  onEditSkill,
  onDeleteSkill,
  onImportSkills,
  onExportSkills,
  refreshKey,
}: SkillsBrowserProps) {
  const [collapsed, setCollapsed] = useState(true);
  const [search, setSearch] = useState("");
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(
    new Set(),
  );

  const allSkills = useMemo(() => getAllSkills(), [refreshKey]);

  const filtered = useMemo(() => {
    if (!search.trim()) return allSkills;
    const q = search.toLowerCase();
    return allSkills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q),
    );
  }, [allSkills, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, SkillTemplate[]>();
    for (const skill of filtered) {
      const list = map.get(skill.category) ?? [];
      list.push(skill);
      map.set(skill.category, list);
    }
    return map;
  }, [filtered]);

  const toggleCategory = (cat: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) {
        next.delete(cat);
      } else {
        next.add(cat);
      }
      return next;
    });
  };

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          bottom: 16,
          right: 16,
          zIndex: 100,
          padding: "8px 12px",
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-default)",
          borderRadius: 8,
          color: "var(--text-secondary)",
          fontSize: 12,
          fontFamily: "var(--font-mono)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 6,
          boxShadow: "var(--shadow-md)",
        }}
      >
        <span style={{ fontSize: 14 }}>&#9889;</span>
        Skills
        {allSkills.length > 0 && (
          <span
            style={{
              fontSize: 10,
              color: "var(--text-muted)",
              background: "var(--bg-primary)",
              padding: "1px 5px",
              borderRadius: 8,
            }}
          >
            {allSkills.length}
          </span>
        )}
      </button>
    );
  }

  return (
    <div
      style={{
        position: "absolute",
        bottom: 16,
        right: 16,
        zIndex: 100,
        width: 300,
        maxHeight: "calc(100% - 80px)",
        background: "var(--bg-secondary)",
        border: "1px solid var(--border-default)",
        borderRadius: 10,
        boxShadow: "var(--shadow-lg)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div
        style={{
          padding: "10px 12px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid var(--border-default)",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: "var(--text-secondary)",
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: 1,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span style={{ fontSize: 14 }}>&#9889;</span>
          Skills ({allSkills.length})
        </span>

        {/* Action buttons */}
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <button
            onClick={onCreateSkill}
            onMouseDown={(e) => e.stopPropagation()}
            title="New Skill"
            style={actionButtonStyle}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--text-secondary)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--text-muted)";
            }}
          >
            +
          </button>
          <button
            onClick={onImportSkills}
            onMouseDown={(e) => e.stopPropagation()}
            title="Import Skills"
            style={actionButtonStyle}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--text-secondary)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--text-muted)";
            }}
          >
            &#8595;
          </button>
          <button
            onClick={onExportSkills}
            onMouseDown={(e) => e.stopPropagation()}
            title="Export Skills"
            style={actionButtonStyle}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--text-secondary)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--text-muted)";
            }}
          >
            &#8593;
          </button>
          <button
            onClick={() => setCollapsed(true)}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              ...actionButtonStyle,
              fontSize: 14,
              padding: "0 4px",
            }}
          >
            &#9654;
          </button>
        </div>
      </div>

      {/* Search */}
      <div
        style={{
          padding: "8px 10px",
          borderBottom: "1px solid var(--border-default)",
          flexShrink: 0,
        }}
      >
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search skills..."
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            width: "100%",
            padding: "6px 10px",
            fontSize: 12,
            background: "var(--bg-primary)",
            border: "1px solid var(--border-default)",
            borderRadius: 6,
            color: "var(--text-primary)",
            fontFamily: "var(--font-mono)",
            outline: "none",
            boxSizing: "border-box",
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = "var(--accent)";
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = "var(--border-default)";
          }}
        />
      </div>

      {/* Skill list */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: "6px",
        }}
      >
        {allSkills.length === 0 && (
          <div
            style={{
              padding: "20px 12px",
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: 11,
            }}
          >
            <div style={{ fontStyle: "italic", marginBottom: 8 }}>
              No skills yet — create one!
            </div>
            <button
              onClick={onCreateSkill}
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                padding: "4px 12px",
                fontSize: 11,
                background: "var(--bg-surface)",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                color: "var(--text-secondary)",
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
              }}
            >
              + Create Skill
            </button>
          </div>
        )}

        {allSkills.length > 0 && filtered.length === 0 && (
          <div
            style={{
              padding: "20px 12px",
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: 11,
              fontStyle: "italic",
            }}
          >
            No skills match your search
          </div>
        )}

        {Array.from(grouped.entries()).map(([category, skills]) => {
          const isCatCollapsed = collapsedCategories.has(category);
          return (
            <div key={category} style={{ marginBottom: 4 }}>
              {/* Category header */}
              <button
                onClick={() => toggleCategory(category)}
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  borderRadius: 4,
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    fontFamily: "var(--font-mono)",
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                    color: "var(--text-muted)",
                  }}
                >
                  {isCatCollapsed ? "\u25B6" : "\u25BC"}{" "}
                  {CATEGORY_LABELS[category] ?? category} ({skills.length})
                </span>
              </button>

              {/* Skill cards */}
              {!isCatCollapsed &&
                skills.map((skill) => {
                  return (
                    <div
                      key={skill.id}
                      style={{
                        width: "100%",
                        marginBottom: 3,
                        borderRadius: 6,
                        background: "var(--bg-surface)",
                        border: "1px solid var(--border-default)",
                        display: "flex",
                        alignItems: "flex-start",
                        transition: "border-color 0.15s",
                        overflow: "hidden",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = skill.accentColor;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor =
                          "var(--border-default)";
                      }}
                    >
                      {/* Main clickable area */}
                      <button
                        onClick={() => onLaunchSkill(skill.id)}
                        onMouseDown={(e) => e.stopPropagation()}
                        style={{
                          flex: 1,
                          padding: "8px 10px",
                          background: "transparent",
                          border: "none",
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 8,
                          textAlign: "left",
                          minWidth: 0,
                        }}
                      >
                        {/* Icon */}
                        <span
                          style={{
                            fontSize: 18,
                            lineHeight: 1,
                            flexShrink: 0,
                          }}
                        >
                          {skill.icon}
                        </span>

                        {/* Text */}
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
                                fontSize: 12,
                                fontWeight: 600,
                                color: "var(--text-primary)",
                              }}
                            >
                              {skill.name}
                            </span>
                            <span
                              style={{
                                width: 6,
                                height: 6,
                                borderRadius: "50%",
                                background: skill.accentColor,
                                flexShrink: 0,
                              }}
                            />
                          </div>
                          <div
                            style={{
                              fontSize: 11,
                              color: "var(--text-muted)",
                              lineHeight: 1.3,
                            }}
                          >
                            {skill.description}
                          </div>
                        </div>
                      </button>

                      {/* Edit for all skills, Delete for custom only */}
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: "4px 4px 4px 0",
                          gap: 2,
                          flexShrink: 0,
                        }}
                      >
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onEditSkill(skill);
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                          title="Edit skill"
                          style={{
                            fontSize: 11,
                            background: "transparent",
                            border: "none",
                            cursor: "pointer",
                            color: "var(--text-muted)",
                            padding: "2px 4px",
                            borderRadius: 3,
                            lineHeight: 1,
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.color =
                              "var(--text-secondary)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.color =
                              "var(--text-muted)";
                          }}
                        >
                          &#9998;
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteSkill(skill.id);
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                          title="Delete skill"
                          style={{
                            fontSize: 11,
                            background: "transparent",
                            border: "none",
                            cursor: "pointer",
                            color: "var(--text-muted)",
                            padding: "2px 4px",
                            borderRadius: 3,
                            lineHeight: 1,
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.color = "var(--danger-color)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.color =
                              "var(--text-muted)";
                          }}
                        >
                          &#215;
                        </button>
                      </div>
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
