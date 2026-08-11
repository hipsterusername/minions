import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { getPickableSkills } from "./skills/registry.ts";
import type { SkillTemplate } from "./skills/types.ts";
import {
  DockPanel,
  DockPanelHeader,
  useDockBadge,
  useDockPanelOpen,
} from "./BottomRightDock.tsx";
import "./skills-browser.css";

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

interface MenuAction {
  label: string;
  icon: React.ReactNode;
  onSelect: () => void;
  danger?: boolean;
}

/**
 * Conventional overflow menu for secondary actions. The menu keeps labels
 * visible, closes on outside click/Escape, and leaves the primary action out
 * of the overflow so the common path is always obvious.
 */
function ActionMenu({ label, actions }: { label: string; actions: MenuAction[] }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Dismiss the nested menu first; a second Escape can close the dock.
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const handleViewportChange = () => setOpen(false);

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLButtonElement>("[role='menuitem']")
        ?.focus();
    });
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [open]);

  const toggleMenu = () => {
    if (open) {
      setOpen(false);
      return;
    }

    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menuWidth = 184;
    const menuHeight = actions.length * 32 + 10;
    const viewportGap = 8;
    const top =
      rect.bottom + 5 + menuHeight <= window.innerHeight - viewportGap
        ? rect.bottom + 5
        : Math.max(viewportGap, rect.top - menuHeight - 5);
    const left = Math.max(
      viewportGap,
      Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - viewportGap),
    );
    setPosition({ top, left });
    setOpen(true);
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']"),
    );
    const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Home") items[0]?.focus();
    else if (event.key === "End") items.at(-1)?.focus();
    else if (event.key === "ArrowDown") items[(activeIndex + 1) % items.length]?.focus();
    else items[(activeIndex - 1 + items.length) % items.length]?.focus();
  };

  return (
    <div className="skills-browser__menu-root">
      <button
        ref={triggerRef}
        type="button"
        className="skills-browser__more-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={toggleMenu}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <MoreHorizontal size={16} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="skills-browser__menu"
          role="menu"
          aria-label={label}
          style={position}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={handleMenuKeyDown}
        >
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              role="menuitem"
              className="skills-browser__menu-item"
              data-danger={action.danger ? "true" : undefined}
              onClick={() => {
                action.onSelect();
                setOpen(false);
              }}
            >
              {action.icon}
              <span>{action.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

/** A single skill with an explicit primary action and a labeled overflow. */
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
  const actions: MenuAction[] = [
    {
      label: "Edit skill",
      icon: <Pencil size={14} aria-hidden="true" />,
      onSelect: onEdit,
    },
    {
      label: "Duplicate skill",
      icon: <Copy size={14} aria-hidden="true" />,
      onSelect: onDuplicate,
    },
    {
      label: "Export skill",
      icon: <Download size={14} aria-hidden="true" />,
      onSelect: onExport,
    },
  ];

  if (!skill.builtIn) {
    actions.push({
      label: "Delete skill",
      icon: <Trash2 size={14} aria-hidden="true" />,
      onSelect: onDelete,
      danger: true,
    });
  }

  return (
    <article
      className="skills-browser__card"
      style={{ "--skill-accent": skill.accentColor } as React.CSSProperties}
    >
      <div className="skills-browser__card-body">
        <span className="skills-browser__skill-icon" aria-hidden="true">
          {skill.icon}
        </span>
        <div className="skills-browser__skill-copy">
          <div className="skills-browser__skill-title-row">
            <h3>{skill.name}</h3>
            {skill.builtIn && (
              <span className="skills-browser__badge" title="Built-in preset">
                Built-in
              </span>
            )}
            {skill.subskills && skill.subskills.length > 0 && (
              <span
                className="skills-browser__badge"
                title={`${skill.subskills.length} sub-skill${
                  skill.subskills.length === 1 ? "" : "s"
                }`}
              >
                {skill.subskills.length} sub
              </span>
            )}
          </div>
          <p>{skill.description}</p>
        </div>
      </div>

      <div className="skills-browser__card-actions">
        <button
          type="button"
          className="skills-browser__launch-button"
          onClick={onLaunch}
          onMouseDown={(event) => event.stopPropagation()}
          aria-label={`Launch with ${skill.name}`}
        >
          <Play size={13} fill="currentColor" aria-hidden="true" />
          Launch
        </button>
        <ActionMenu label={`More actions for ${skill.name}`} actions={actions} />
      </div>
    </article>
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

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragActive(false);
    const file = Array.from(event.dataTransfer.files).find(
      (candidate) =>
        candidate.type === "application/json" || candidate.name.endsWith(".json"),
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
    const query = search.toLowerCase();
    return allSkills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(query) ||
        skill.description.toLowerCase().includes(query) ||
        skill.category.toLowerCase().includes(query),
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

  const toggleCategory = (category: string) => {
    setCollapsedCategories((previous) => {
      const next = new Set(previous);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  if (!isOpen) return null;

  return (
    <DockPanel id="skills" width={320}>
      <div
        className="skills-browser"
        onDragOver={(event) => {
          event.preventDefault();
          if (!dragActive) setDragActive(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDragActive(false);
          }
        }}
        onDrop={handleDrop}
      >
        {dragActive && (
          <div className="skills-browser__drop-zone" role="status" aria-live="polite">
            <Upload size={20} aria-hidden="true" />
            Drop a skills JSON file to import
          </div>
        )}

        <DockPanelHeader
          title={
            <>
              Skills
              <span className="skills-browser__title-count">{allSkills.length}</span>
            </>
          }
          actions={
            <>
              <button
                type="button"
                className="skills-browser__new-button"
                onClick={onCreateSkill}
                onMouseDown={(event) => event.stopPropagation()}
              >
                <Plus size={14} strokeWidth={2.2} aria-hidden="true" />
                New
              </button>
              <ActionMenu
                label="Skill library actions"
                actions={[
                  {
                    label: "Import skills",
                    icon: <Upload size={14} aria-hidden="true" />,
                    onSelect: onImportSkills,
                  },
                  {
                    label: "Export all skills",
                    icon: <Download size={14} aria-hidden="true" />,
                    onSelect: onExportSkills,
                  },
                ]}
              />
            </>
          }
        />

        <div className="skills-browser__toolbar">
          <p>Choose a workflow, then launch a new leader with it armed.</p>
          <label className="skills-browser__search">
            <Search size={14} aria-hidden="true" />
            <span className="skills-browser__sr-only">Search skills</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search skills"
              onMouseDown={(event) => event.stopPropagation()}
            />
          </label>
        </div>

        <div className="skills-browser__list">
          {allSkills.length === 0 && (
            <div className="skills-browser__empty">
              <span className="skills-browser__empty-icon" aria-hidden="true">✦</span>
              <strong>No skills yet</strong>
              <p>Create a reusable workflow to guide your next leader.</p>
              <button type="button" onClick={onCreateSkill}>
                <Plus size={14} aria-hidden="true" />
                Create first skill
              </button>
            </div>
          )}

          {allSkills.length > 0 && filtered.length === 0 && (
            <div className="skills-browser__empty">
              <Search size={19} aria-hidden="true" />
              <strong>No matching skills</strong>
              <p>Try a different name, description, or category.</p>
              <button type="button" onClick={() => setSearch("")}>Clear search</button>
            </div>
          )}

          {Array.from(grouped.entries()).map(([category, skills]) => {
            const collapsed = collapsedCategories.has(category);
            const categoryLabel = CATEGORY_LABELS[category] ?? category;
            return (
              <section className="skills-browser__category" key={category}>
                <button
                  type="button"
                  className="skills-browser__category-button"
                  onClick={() => toggleCategory(category)}
                  onMouseDown={(event) => event.stopPropagation()}
                  aria-expanded={!collapsed}
                >
                  <span>
                    {collapsed ? (
                      <ChevronRight size={14} aria-hidden="true" />
                    ) : (
                      <ChevronDown size={14} aria-hidden="true" />
                    )}
                    {categoryLabel}
                  </span>
                  <span className="skills-browser__category-count">{skills.length}</span>
                </button>

                {!collapsed && (
                  <div className="skills-browser__category-list">
                    {skills.map((skill) => (
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
                )}
              </section>
            );
          })}
        </div>
      </div>
    </DockPanel>
  );
}
