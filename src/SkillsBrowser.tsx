import { useState, useMemo } from "react";
import { getPickableSkills } from "./skills/registry.ts";
import type { SkillTemplate } from "./skills/types.ts";
import {
  DockPanel,
  DockPanelHeader,
  useDockBadge,
  useDockPanelOpen,
} from "./BottomRightDock.tsx";

interface SkillsBrowserProps {
  onLaunchSkill: (skillId: string) => void;
  onCreateSkill: () => void;
  onEditSkill: (skill: SkillTemplate) => void;
  onDeleteSkill: (skillId: string) => void;
  onDuplicateSkill: (skill: SkillTemplate) => void;
  onExportSkill: (skill: SkillTemplate) => void;
  onImportSkills: () => void;
  onExportSkills: () => void;
  /** Called with the text of a `.json` file dropped onto the panel. */
  onImportFile: (text: string) => void;
  refreshKey?: number;
}

/** Compact icon button used for both the header and per-card actions. */
function IconButton({
  label,
  glyph,
  onClick,
  hoverColor = "var(--text-secondary)",
}: {
  label: string;
  glyph: React.ReactNode;
  onClick: (e: React.MouseEvent) => void;
  hoverColor?: string;
}) {
  return (
    <button
      onClick={onClick}
      onMouseDown={(e) => e.stopPropagation()}
      title={label}
      aria-label={label}
      style={actionButtonStyle}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = hoverColor;
        e.currentTarget.style.background = "var(--bg-elevated)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = "var(--text-muted)";
        e.currentTarget.style.background = "transparent";
      }}
      onFocus={(e) => {
        e.currentTarget.style.color = hoverColor;
        e.currentTarget.style.background = "var(--bg-elevated)";
      }}
      onBlur={(e) => {
        e.currentTarget.style.color = "var(--text-muted)";
        e.currentTarget.style.background = "transparent";
      }}
    >
      {glyph}
    </button>
  );
}

/**
 * A single skill row. Per-card actions (edit/duplicate/export/delete) stay
 * mounted for accessibility + tests but are visually revealed only when the
 * card is hovered or contains keyboard focus, cutting the resting clutter.
 * Their column keeps a fixed width so revealing them causes no layout shift.
 */
function SkillCard({
  skill,
  onLaunch,
  onEdit,
  onDuplicate,
  onExport,
  onDelete,
}: {
  skill: SkillTemplate;
  onLaunch: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  const [active, setActive] = useState(false);

  return (
    <div
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
        setActive(true);
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--border-default)";
        setActive(false);
      }}
      onFocus={() => setActive(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setActive(false);
        }
      }}
    >
      {/* Main clickable area */}
      <button
        onClick={onLaunch}
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
        <span style={{ fontSize: 18, lineHeight: 1, flexShrink: 0 }}>
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
            {skill.builtIn && (
              <span
                title="Built-in preset (read-only)"
                style={{
                  fontSize: 9,
                  fontFamily: "var(--font-mono)",
                  color: "var(--text-muted)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 4,
                  padding: "0 4px",
                  flexShrink: 0,
                }}
              >
                built-in
              </span>
            )}
            {skill.subskills && skill.subskills.length > 0 && (
              <span
                title={`${skill.subskills.length} sub-skill${skill.subskills.length === 1 ? "" : "s"}`}
                style={{
                  fontSize: 9,
                  fontFamily: "var(--font-mono)",
                  color: "var(--text-secondary)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 4,
                  padding: "0 4px",
                  flexShrink: 0,
                }}
              >
                {skill.subskills.length}▸
              </span>
            )}
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

      {/* Actions: edit/duplicate/export for all, delete for custom.
          Revealed on hover/focus; column width is reserved to avoid shift. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          alignItems: "center",
          justifyItems: "center",
          padding: "4px 4px 4px 0",
          gap: 0,
          flexShrink: 0,
          opacity: active ? 1 : 0,
          transition: "opacity 0.12s ease",
        }}
      >
        <IconButton
          label="Edit skill"
          glyph={<>&#9998;</>}
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
        />
        <IconButton
          label="Duplicate skill"
          glyph={<>&#10697;</>}
          onClick={(e) => {
            e.stopPropagation();
            onDuplicate();
          }}
        />
        <IconButton
          label="Export skill"
          glyph={<>&#8681;</>}
          onClick={(e) => {
            e.stopPropagation();
            onExport();
          }}
        />
        {/* Built-in presets are code-authored: not deletable
            (editing one creates a project override instead). */}
        {!skill.builtIn && (
          <IconButton
            label="Delete skill"
            glyph={<>&#215;</>}
            hoverColor="var(--danger-color)"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          />
        )}
      </div>
    </div>
  );
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
  onDuplicateSkill,
  onExportSkill,
  onImportSkills,
  onExportSkills,
  onImportFile,
  refreshKey,
}: SkillsBrowserProps) {
  const isOpen = useDockPanelOpen("skills");
  const [search, setSearch] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(
    new Set(),
  );

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const file = Array.from(e.dataTransfer.files).find(
      (f) => f.type === "application/json" || f.name.endsWith(".json"),
    );
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onImportFile(reader.result as string);
    reader.readAsText(file);
  };

  const allSkills = useMemo(() => getPickableSkills(), [refreshKey]);

  useDockBadge("skills", { count: allSkills.length });

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

  if (!isOpen) return null;

  return (
    <DockPanel id="skills" width={300}>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragActive) setDragActive(true);
        }}
        onDragLeave={(e) => {
          // Only clear when the pointer actually leaves the panel bounds.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setDragActive(false);
          }
        }}
        onDrop={handleDrop}
        style={{
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          flex: 1,
          position: "relative",
        }}
      >
        {dragActive && (
          <div
            role="status"
            aria-live="polite"
            style={{
              position: "absolute",
              inset: 6,
              zIndex: 5,
              borderRadius: 8,
              border: "2px dashed var(--accent)",
              background: "var(--overlay-bg)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              color: "var(--accent)",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
            }}
          >
            Drop skills .json to import
          </div>
        )}
      <DockPanelHeader
        title={<>Skills ({allSkills.length})</>}
        actions={
          <>
            <IconButton label="New skill" glyph="+" onClick={onCreateSkill} />
            <IconButton
              label="Import skills"
              glyph={<>&#8595;</>}
              onClick={onImportSkills}
            />
            <IconButton
              label="Export all skills"
              glyph={<>&#8593;</>}
              onClick={onExportSkills}
            />
          </>
        }
      />

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
                skills.map((skill) => (
                  <SkillCard
                    key={skill.id}
                    skill={skill}
                    onLaunch={() => onLaunchSkill(skill.id)}
                    onEdit={() => onEditSkill(skill)}
                    onDuplicate={() => onDuplicateSkill(skill)}
                    onExport={() => onExportSkill(skill)}
                    onDelete={() => onDeleteSkill(skill.id)}
                  />
                ))}
            </div>
          );
        })}
      </div>
      </div>
    </DockPanel>
  );
}
