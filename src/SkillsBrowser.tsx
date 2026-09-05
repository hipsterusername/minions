import { MinionsIcon } from "./components/MinionsIcon.tsx";
import { SkillIcon } from "./components/SkillIcon.tsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
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
  useDock,
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
    const focusFrame = requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLButtonElement>("[role='menuitem']")
        ?.focus();
    });
    return () => {
      cancelAnimationFrame(focusFrame);
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
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === "Tab") {
      // Resume tab order at the trigger instead of the end of the portal.
      triggerRef.current?.focus();
      setOpen(false);
      return;
    }
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

const CATEGORY_LABELS: Record<SkillTemplate["category"], string> = {
  code: "Code", docs: "Docs", testing: "Testing", devops: "DevOps",
  analysis: "Analysis", design: "Design", general: "General",
};

function SkillDetails({ skill, onBack, onLaunch, onEdit, onDuplicate, onExport, onDelete }: {
  skill: SkillTemplate;
  onBack: () => void;
  onLaunch: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headingRef.current?.focus(); }, [skill.id]);
  const actions: MenuAction[] = [
    { label: "Edit skill", icon: <Pencil size={14} aria-hidden="true" />, onSelect: onEdit },
    { label: "Duplicate skill", icon: <Copy size={14} aria-hidden="true" />, onSelect: onDuplicate },
    { label: "Export skill", icon: <Download size={14} aria-hidden="true" />, onSelect: onExport },
    ...(!skill.builtIn ? [{ label: "Delete skill", icon: <Trash2 size={14} aria-hidden="true" />, onSelect: onDelete, danger: true }] : []),
  ];
  return (
    <div className="skills-browser__detail" style={{ "--skill-accent": skill.accentColor } as React.CSSProperties}>
      <div className="skills-browser__detail-nav">
        <button type="button" className="skills-browser__back" onClick={onBack}><ArrowLeft size={14} aria-hidden="true" /> All skills</button>
        <ActionMenu label={`More actions for ${skill.name}`} actions={actions} />
      </div>
      <div className="skills-browser__detail-scroll">
        <div className="skills-browser__detail-hero">
          <span className="skills-browser__skill-icon"><SkillIcon skill={skill} size={24} /></span>
          <div><span className="skills-browser__eyebrow">{CATEGORY_LABELS[skill.category]} · {skill.builtIn ? "Built-in" : "Project skill"}</span>
            <h3 ref={headingRef} tabIndex={-1}>{skill.name}</h3></div>
        </div>
        <p className="skills-browser__detail-description">{skill.description || "Reusable instructions to guide your leader."}</p>
        <div className="skills-browser__next-step">
          <MinionsIcon name="skill" size={18} />
          <div><strong>Make it part of your next task</strong><p>Launch adds a leader to the canvas with this skill selected. Add your task{skill.variables.length ? " and configure its inputs" : ""} there before starting.</p></div>
        </div>
        <div className="skills-browser__disclosures">
          {skill.variables.length > 0 && (
            <details><summary>Inputs <span>{skill.variables.length}</span></summary>
              <p className="skills-browser__hint">Configure these on the leader after launch.</p>
              <dl>{skill.variables.map((variable) => (
                <div key={variable.name}><dt>{variable.label || variable.name}{variable.required && <span className="skills-browser__badge">Required</span>}</dt>
                  <dd>{variable.description || variable.placeholder || (variable.type === "select" ? "Choose an option" : "Enter a value")}
                    {variable.defaultValue && <small>Default: {variable.defaultValue}</small>}
                  </dd></div>
              ))}</dl>
            </details>
          )}
          {!!skill.subskills?.length && (
            <details><summary>Sub-skills <span>{skill.subskills.length}</span></summary>
              <p className="skills-browser__hint">Specialized guidance the leader can draw on.</p>
              <dl>{skill.subskills.map((subskill) => <div key={subskill.id}><dt>{subskill.name}</dt><dd>{subskill.description}{subskill.whenToUse && <small>When: {subskill.whenToUse}</small>}</dd></div>)}</dl>
            </details>
          )}
          {!!skill.attachments?.length && (
            <details><summary>Reference files <span>{skill.attachments.length}</span></summary>
              <ul>{skill.attachments.map((attachment, index) => <li key={`${attachment.filename}-${index}`}>{attachment.filename}</li>)}</ul>
            </details>
          )}
          <details><summary>Instructions <MinionsIcon name="file" size={14} /></summary>
            <pre>{skill.template || "No instructions yet. Edit this skill to add them."}</pre>
          </details>
        </div>
      </div>
      <div className="skills-browser__detail-footer">
        <button type="button" className="skills-browser__launch-button" aria-label={`Launch with ${skill.name}`} onClick={onLaunch}>
          <Play size={14} fill="currentColor" aria-hidden="true" /> Launch with skill
        </button>
        <span>You choose when the leader starts.</span>
      </div>
    </div>
  );
}

export function SkillsBrowser({
  onLaunchSkill, onCreateSkill, onEditSkill, onDeleteSkill, onDuplicateSkill,
  onExportSkill, onImportSkills, onExportSkills, onImportFile, refreshKey,
}: SkillsBrowserProps) {
  const isOpen = useDockPanelOpen("skills");
  const { closePanel } = useDock();
  const [search, setSearch] = useState("");
  const [source, setSource] = useState<"all" | "project" | "built-in">("all");
  const [category, setCategory] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef<string | null>(null);
  const scrollTop = useRef(0);
  const allSkills = useMemo(() => getPickableSkills(), [refreshKey]);
  const selected = allSkills.find((skill) => skill.id === selectedId);
  useDockBadge("skills", { count: allSkills.length });
  const query = search.trim().toLowerCase();
  const filtered = allSkills.filter((skill) =>
    (source === "all" || (source === "built-in" ? skill.builtIn : !skill.builtIn)) &&
    (category === "all" || skill.category === category) &&
    (!query || `${skill.name} ${skill.description} ${skill.category}`.toLowerCase().includes(query)),
  );
  const hasFilters = Boolean(query) || source !== "all" || category !== "all";
  const backToLibrary = () => { restoreFocus.current = selectedId; setSelectedId(null); };
  useEffect(() => {
    if (!selected && listRef.current) {
      listRef.current.scrollTop = scrollTop.current;
      const target = Array.from(listRef.current.querySelectorAll<HTMLButtonElement>("[data-skill-id]"))
        .find((button) => button.dataset["skillId"] === restoreFocus.current);
      (target ?? searchRef.current)?.focus({ preventScroll: true });
      restoreFocus.current = null;
    }
  }, [selected, isOpen]);
  useEffect(() => { if (!isOpen) setDragActive(false); }, [isOpen]);

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault(); setDragActive(false);
    const file = Array.from(event.dataTransfer.files).find((candidate) => candidate.type === "application/json" || candidate.name.endsWith(".json"));
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onImportFile(reader.result as string);
    reader.readAsText(file);
  };
  if (!isOpen) return null;
  return (
    <DockPanel id="skills" width={400}>
      <div className="skills-browser" onKeyDown={(event) => {
        if (event.key === "Escape" && selected && !event.defaultPrevented) {
          event.stopPropagation(); backToLibrary();
        }
      }} onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault(); setDragActive(true);
      }} onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
      }} onDrop={handleDrop}>
        {dragActive && <div className="skills-browser__drop-zone" role="status"><Upload size={20} aria-hidden="true" /> Drop a skills JSON file to import</div>}
        <DockPanelHeader title={<>Skills <span className="skills-browser__title-count">{allSkills.length}</span></>} actions={!selected ? <>
          <button type="button" className="skills-browser__new-button" onClick={onCreateSkill}><Plus size={14} aria-hidden="true" /> New skill</button>
          <ActionMenu label="Skill library actions" actions={[
            { label: "Import skills", icon: <Upload size={14} aria-hidden="true" />, onSelect: onImportSkills },
            { label: "Export all skills", icon: <Download size={14} aria-hidden="true" />, onSelect: onExportSkills },
          ]} />
        </> : undefined} />
        {selected ? <SkillDetails key={selected.id} skill={selected} onBack={backToLibrary}
          onLaunch={() => { onLaunchSkill(selected.id); closePanel(); setSelectedId(null); }}
          onEdit={() => onEditSkill(selected)} onDuplicate={() => onDuplicateSkill(selected)}
          onExport={() => onExportSkill(selected)} onDelete={() => onDeleteSkill(selected.id)} /> : <>
          <div className="skills-browser__toolbar">
            <div className="skills-browser__intro"><strong>A little expertise for every task.</strong><p>Choose a skill to see how it can help.</p></div>
            <label className="skills-browser__search"><Search size={15} aria-hidden="true" />
              <span className="skills-browser__sr-only">Search skills</span>
              <input ref={searchRef} type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a skill…" />
            </label>
            <div className="skills-browser__filters">
              <div className="skills-browser__sources" role="group" aria-label="Skill source">
                {([['all', 'All skills'], ['project', 'Yours'], ['built-in', 'Built-in']] as const).map(([value, label]) =>
                  <button key={value} type="button" aria-pressed={source === value} onClick={() => setSource(value)}>{label}</button>)}
              </div>
              <select aria-label="Skill category" value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">All categories</option>
                {Object.entries(CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
          </div>
          <div className="skills-browser__list" ref={listRef}>
            <p className="skills-browser__results" role="status">{filtered.length} {hasFilters ? "matching" : "available"} skill{filtered.length === 1 ? "" : "s"}</p>
            {filtered.map((skill) => <button key={skill.id} type="button" className="skills-browser__row" data-skill-id={skill.id}
              style={{ "--skill-accent": skill.accentColor } as React.CSSProperties} aria-label={`View ${skill.name}`}
              onClick={() => { scrollTop.current = listRef.current?.scrollTop ?? 0; setSelectedId(skill.id); }}>
              <span className="skills-browser__skill-icon"><SkillIcon skill={skill} size={20} /></span>
              <span className="skills-browser__row-copy"><strong>{skill.name}</strong><span>{skill.description || CATEGORY_LABELS[skill.category]}</span></span>
              <ChevronRight size={15} aria-hidden="true" />
            </button>)}
            {!filtered.length && <div className="skills-browser__empty">
              <MinionsIcon name={hasFilters ? "analysis" : "skill"} size={24} />
              <strong>{source === "project" && !query && category === "all" ? "Make your first skill" : hasFilters ? "No matching skills" : "No skills yet"}</strong>
              <p>{source === "project" && !query && category === "all" ? "Turn the way you work into reusable instructions. Start from scratch or duplicate a built-in skill." : "Try a different search, or create a skill for your workflow."}</p>
              {hasFilters && <button type="button" onClick={() => { setSearch(""); setSource("all"); setCategory("all"); }}>Reset filters</button>}
              <button type="button" onClick={onCreateSkill}><Plus size={14} aria-hidden="true" /> Create skill</button>
            </div>}
          </div>
          <div className="skills-browser__library-footer"><MinionsIcon name="lightbulb" size={14} /><span>Explore a skill, then bring it to your canvas.</span></div>
        </>}
      </div>
    </DockPanel>
  );
}
