import { SkillIcon } from "../../../components/SkillIcon.tsx";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useId,
  type CSSProperties,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Check, Plus, Search, Settings2, X, Zap } from "lucide-react";
import { getPickableSkills, getSkill } from "../../../skills/registry.ts";
import type { SkillTemplate } from "../../../skills/types.ts";
import { SkillTagChip } from "./SkillTagChip.tsx";
import { SkillVariableInputs } from "./SkillVariableInputs.tsx";

const SKILL_CATEGORIES: { key: SkillTemplate["category"]; label: string }[] = [
  { key: "code", label: "Code" },
  { key: "docs", label: "Docs" },
  { key: "testing", label: "Testing" },
  { key: "devops", label: "DevOps" },
  { key: "analysis", label: "Analysis" },
  { key: "design", label: "Design" },
  { key: "general", label: "General" },
];

const FLYOUT_W = 720;
const FLYOUT_H = 520;
const FLYOUT_GAP = 6;
const VIEWPORT_GAP = 8;

type CompactPane = "browse" | "configure";

/**
 * Searchable skill picker and configurator anchored to a leader node.
 * It becomes a two-tab dialog on compact canvases so neither the library nor
 * the configuration form is squeezed into an unusable column.
 */
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
  const [compactPane, setCompactPane] = useState<CompactPane>("browse");
  const [layout, setLayout] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
    compact: boolean;
  } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const descriptionId = useId();
  const browsePanelId = useId();
  const configurePanelId = useId();

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useLayoutEffect(() => {
    if (!open) {
      setLayout(null);
      return;
    }

    const positionFlyout = () => {
      const rect = anchorRef?.current?.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const compact = viewportWidth < 720;
      const width = Math.min(
        FLYOUT_W,
        Math.max(0, viewportWidth - VIEWPORT_GAP * 2),
      );
      const height = Math.min(
        compact ? 620 : FLYOUT_H,
        Math.max(0, viewportHeight - VIEWPORT_GAP * 2),
      );

      if (compact || !rect) {
        setLayout({
          top: Math.max(VIEWPORT_GAP, viewportHeight - height - VIEWPORT_GAP),
          left: Math.max(VIEWPORT_GAP, (viewportWidth - width) / 2),
          width,
          height,
          compact,
        });
        return;
      }

      let top = rect.bottom + FLYOUT_GAP;
      if (top + height > viewportHeight - VIEWPORT_GAP) {
        top = rect.top - height - FLYOUT_GAP;
      }
      top = Math.max(
        VIEWPORT_GAP,
        Math.min(top, viewportHeight - height - VIEWPORT_GAP),
      );
      const left = Math.max(
        VIEWPORT_GAP,
        Math.min(rect.left, viewportWidth - width - VIEWPORT_GAP),
      );
      setLayout({ top, left, width, height, compact });
    };

    positionFlyout();
    window.addEventListener("resize", positionFlyout);
    return () => window.removeEventListener("resize", positionFlyout);
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;

    setSearchQuery("");
    setCompactPane("browse");
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null || element === document.activeElement);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      anchorRef?.current?.focus();
    };
  }, [open, anchorRef]);

  const allSkills = getPickableSkills();
  const selectedIds = useMemo(() => new Set(skillIds), [skillIds]);
  const taggedSkills = skillIds
    .map((id) => getSkill(id))
    .filter((skill): skill is SkillTemplate => skill !== undefined);

  const handleAddSkill = (id: string) => {
    if (!selectedIds.has(id)) {
      onUpdate({ skillIds: [...skillIds, id], skillPanelOpen: true });
    }
  };

  const handleRemoveSkill = (id: string) => {
    const nextValues = { ...skillValues };
    delete nextValues[id];
    onUpdate({
      skillIds: skillIds.filter((skillId) => skillId !== id),
      skillValues: nextValues,
    });
  };

  const handleVarChange = (skillId: string, varName: string, value: string) => {
    const current = skillValues[skillId] ?? {};
    onUpdate({
      skillValues: { ...skillValues, [skillId]: { ...current, [varName]: value } },
    });
  };

  const query = searchQuery.toLowerCase().trim();
  const browseByCategory = SKILL_CATEGORIES.map((category) => ({
    ...category,
    skills: allSkills.filter(
      (skill) =>
        skill.category === category.key &&
        (!readOnly || selectedIds.has(skill.id)) &&
        (query === "" ||
          skill.name.toLowerCase().includes(query) ||
          skill.description.toLowerCase().includes(query) ||
          category.label.toLowerCase().includes(query)),
    ),
  })).filter((category) => category.skills.length > 0);
  const visibleSkillCount = browseByCategory.reduce(
    (count, category) => count + category.skills.length,
    0,
  );

  if (!open) return null;

  return createPortal(
    <>
      <div
        className="skill-flyout__backdrop"
        aria-hidden="true"
        onMouseDown={onClose}
      />
      <div
        ref={dialogRef}
        className="skill-flyout"
        data-compact={layout?.compact ? "true" : undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onMouseDown={(event) => event.stopPropagation()}
        style={{
          top: layout?.top ?? VIEWPORT_GAP,
          left: layout?.left ?? VIEWPORT_GAP,
          width: layout?.width ?? `calc(100vw - ${VIEWPORT_GAP * 2}px)`,
          height: layout?.height ?? `calc(100vh - ${VIEWPORT_GAP * 2}px)`,
        }}
      >
        <header className="skill-flyout__header">
          <div className="skill-flyout__heading-icon" aria-hidden="true">
            <Zap size={16} fill="currentColor" />
          </div>
          <div className="skill-flyout__heading-copy">
            <div className="skill-flyout__title-row">
              <h2 id={titleId}>Skills</h2>
              <span className="skill-flyout__selected-count" aria-live="polite">
                {taggedSkills.length} selected
              </span>
            </div>
            <p id={descriptionId}>
              {readOnly
                ? "Skills attached to this leader"
                : "Choose reusable instructions and configure them for this leader"}
            </p>
          </div>
          <button
            type="button"
            className="skill-flyout__icon-button"
            onClick={onClose}
            title="Close skills"
            aria-label="Close skills"
          >
            <X size={17} aria-hidden="true" />
          </button>
        </header>

        {layout?.compact && (
          <div className="skill-flyout__tabs" role="tablist" aria-label="Skill menu sections">
            <button
              type="button"
              role="tab"
              aria-selected={compactPane === "browse"}
              aria-controls={browsePanelId}
              onClick={() => setCompactPane("browse")}
            >
              <Search size={14} aria-hidden="true" />
              Browse
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={compactPane === "configure"}
              aria-controls={configurePanelId}
              onClick={() => setCompactPane("configure")}
            >
              <Settings2 size={14} aria-hidden="true" />
              Configure
              <span>{taggedSkills.length}</span>
            </button>
          </div>
        )}

        <div className="skill-flyout__body">
          <section
            id={browsePanelId}
            className="skill-flyout__browser"
            data-hidden={layout?.compact && compactPane !== "browse" ? "true" : undefined}
            aria-label="Browse skills"
          >
            <div className="skill-flyout__browser-header">
              <div className="skill-flyout__section-heading">
                <strong>{readOnly ? "Attached skills" : "Skill library"}</strong>
                <span>{visibleSkillCount}</span>
              </div>
              <label className="skill-flyout__search">
                <Search size={14} aria-hidden="true" />
                <span className="skill-flyout__sr-only">Search skills</span>
                <input
                  ref={searchRef}
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search skills"
                  autoComplete="off"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery("");
                      searchRef.current?.focus();
                    }}
                    title="Clear search"
                    aria-label="Clear skill search"
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                )}
              </label>
            </div>

            <div className="skill-flyout__skill-list">
              {browseByCategory.length === 0 && (
                <div className="skill-flyout__empty" role="status">
                  <Search size={20} aria-hidden="true" />
                  <strong>{query ? "No matching skills" : "No skills available"}</strong>
                  <span>
                    {query
                      ? `Try another search for “${searchQuery.trim()}”.`
                      : readOnly
                        ? "No skills are attached to this leader."
                        : "Create or import a skill from the Skills library."}
                  </span>
                  {query && (
                    <button type="button" onClick={() => setSearchQuery("")}>
                      Clear search
                    </button>
                  )}
                </div>
              )}

              {browseByCategory.map((category) => (
                <section className="skill-flyout__category" key={category.key}>
                  <h3>
                    {category.label}
                    <span>{category.skills.length}</span>
                  </h3>
                  <div>
                    {category.skills.map((skill) => {
                      const selected = selectedIds.has(skill.id);
                      return (
                        <article
                          className="skill-flyout__skill-row"
                          data-selected={selected ? "true" : undefined}
                          key={skill.id}
                          style={{ "--skill-color": skill.accentColor } as CSSProperties}
                        >
                          <span className="skill-flyout__skill-icon" aria-hidden="true">
                            <SkillIcon skill={skill} />
                          </span>
                          <div className="skill-flyout__skill-copy">
                            <strong>{skill.name}</strong>
                            <span>{skill.description}</span>
                          </div>
                          {readOnly ? (
                            <span className="skill-flyout__readonly-state">
                              <Check size={13} aria-hidden="true" />
                              Selected
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="skill-flyout__select-button"
                              data-selected={selected ? "true" : undefined}
                              onClick={() =>
                                selected
                                  ? handleRemoveSkill(skill.id)
                                  : handleAddSkill(skill.id)
                              }
                              aria-label={`${selected ? "Remove" : "Add"} ${skill.name}`}
                            >
                              {selected ? (
                                <X size={13} aria-hidden="true" />
                              ) : (
                                <Plus size={13} aria-hidden="true" />
                              )}
                              {selected ? "Remove" : "Add"}
                            </button>
                          )}
                        </article>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </section>

          <section
            id={configurePanelId}
            className="skill-flyout__configuration"
            data-hidden={layout?.compact && compactPane !== "configure" ? "true" : undefined}
            aria-label="Configure selected skills"
          >
            <div className="skill-flyout__configuration-header">
              <div className="skill-flyout__section-heading">
                <strong>Selected skills</strong>
                <span>{taggedSkills.length}</span>
              </div>
              {taggedSkills.length > 0 && (
                <div className="skill-flyout__chips" aria-label="Selected skills">
                  {taggedSkills.map((skill) => (
                    <SkillTagChip
                      key={skill.id}
                      skill={skill}
                      readOnly={readOnly}
                      onRemove={() => handleRemoveSkill(skill.id)}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="skill-flyout__configuration-list">
              {taggedSkills.length === 0 && (
                <div className="skill-flyout__empty skill-flyout__empty--configuration">
                  <div aria-hidden="true"><Settings2 size={22} /></div>
                  <strong>No skills selected</strong>
                  <span>Choose a skill from the library to configure it here.</span>
                  {layout?.compact && !readOnly && (
                    <button type="button" onClick={() => setCompactPane("browse")}>
                      Browse skills
                    </button>
                  )}
                </div>
              )}

              {taggedSkills.map((skill) => (
                <section
                  className="skill-flyout__config-card"
                  key={skill.id}
                  style={{ "--skill-color": skill.accentColor } as CSSProperties}
                >
                  <header>
                    <span className="skill-flyout__skill-icon" aria-hidden="true">
                      <SkillIcon skill={skill} />
                    </span>
                    <div>
                      <h3>{skill.name}</h3>
                      <p>{skill.description}</p>
                    </div>
                    {!readOnly && (
                      <button
                        type="button"
                        onClick={() => handleRemoveSkill(skill.id)}
                        title={`Remove ${skill.name}`}
                        aria-label={`Remove ${skill.name} from leader`}
                      >
                        <X size={13} aria-hidden="true" />
                        Remove
                      </button>
                    )}
                  </header>
                  {skill.variables.length === 0 ? (
                    <p className="skill-flyout__no-configuration">
                      <Check size={14} aria-hidden="true" />
                      Ready to use — no configuration needed.
                    </p>
                  ) : (
                    <SkillVariableInputs
                      skill={skill}
                      values={skillValues[skill.id] ?? {}}
                      onChange={(varName, value) =>
                        handleVarChange(skill.id, varName, value)
                      }
                      readOnly={readOnly}
                    />
                  )}
                </section>
              ))}
            </div>
          </section>
        </div>
      </div>
    </>,
    document.body,
  );
}
