import { useState, useCallback, useEffect, useRef, type Dispatch } from "react";
import type {
  KanbanBoard as KanbanBoardType,
  KanbanCard,
  KanbanAction,
  KanbanSubtask,
  ModelOption,
  PermissionMode,
} from "./kanban-types.ts";
import { getAllSkills, getSkill } from "./skills/registry.ts";
import type { SkillTemplate } from "./skills/types.ts";
import type { ServerMessage } from "./use-socket.ts";
import { CardCreationChat } from "./CardCreationChat.tsx";
import "./kanban.css";

// ─── Helpers ──────────────────────────────────────────────

let _idCounter = 0;
function genId(): string {
  return `kb-${Date.now()}-${++_idCounter}`;
}

const PRIORITY_LABELS: Record<KanbanCard["priority"], string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

// ─── Hooks ────────────────────────────────────────────────

/** Close on Escape key */
function useEscapeKey(onClose: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [onClose, active]);
}

/** Close on click outside ref element */
function useClickOutside(
  ref: React.RefObject<HTMLElement | null>,
  onClose: () => void,
  active: boolean,
) {
  useEffect(() => {
    if (!active) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const id = requestAnimationFrame(() => {
      document.addEventListener("mousedown", handler);
    });
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("mousedown", handler);
    };
  }, [ref, onClose, active]);
}

/** Auto-scroll element into view when it mounts */
function useScrollIntoView(ref: React.RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active || !ref.current) return;
    const id = requestAnimationFrame(() => {
      ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    return () => cancelAnimationFrame(id);
  }, [ref, active]);
}

// ─── Card Form ────────────────────────────────────────────

interface CardFormData {
  title: string;
  description: string;
  context: string;
  priority: KanbanCard["priority"];
  subtasks: KanbanSubtask[];
  model: ModelOption;
  permissionMode: PermissionMode;
  worktreeIsolation: boolean;
  skillIds: string[];
  skillValues: Record<string, Record<string, string>>;
}

const MODEL_LABELS: Record<ModelOption, string> = {
  sonnet: "Sonnet",
  opus: "Opus",
  haiku: "Haiku",
};

const PERMISSION_LABELS: Record<PermissionMode, string> = {
  bypassPermissions: "Bypass",
  default: "Default",
  plan: "Plan",
  acceptEdits: "Accept Edits",
};

const PERMISSION_DESCRIPTIONS: Record<PermissionMode, string> = {
  bypassPermissions: "Skip all permission checks",
  default: "Ask before dangerous operations",
  plan: "Plan only, no execution",
  acceptEdits: "Auto-accept file edits only",
};

const SKILL_CATEGORIES = [
  { key: "code", label: "Code" },
  { key: "docs", label: "Docs" },
  { key: "testing", label: "Testing" },
  { key: "devops", label: "DevOps" },
  { key: "analysis", label: "Analysis" },
  { key: "design", label: "Design" },
  { key: "general", label: "General" },
] as const;

function SkillPicker({
  skillIds,
  skillValues,
  onUpdate,
}: {
  skillIds: string[];
  skillValues: Record<string, Record<string, string>>;
  onUpdate: (ids: string[], values: Record<string, Record<string, string>>) => void;
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const allSkills = getAllSkills();
  const taggedSkills = skillIds
    .map((id) => getSkill(id))
    .filter((s): s is SkillTemplate => s !== undefined);

  const categorized = SKILL_CATEGORIES
    .map((cat) => ({
      ...cat,
      skills: allSkills.filter(
        (s) => s.category === cat.key && !skillIds.includes(s.id),
      ),
    }))
    .filter((cat) => cat.skills.length > 0);

  const handleAdd = (id: string) => {
    onUpdate([...skillIds, id], skillValues);
    setDropdownOpen(false);
  };

  const handleRemove = (id: string) => {
    const nextIds = skillIds.filter((s) => s !== id);
    const nextVals = { ...skillValues };
    delete nextVals[id];
    onUpdate(nextIds, nextVals);
  };

  const handleVarChange = (skillId: string, varName: string, value: string) => {
    const current = skillValues[skillId] ?? {};
    onUpdate(skillIds, {
      ...skillValues,
      [skillId]: { ...current, [varName]: value },
    });
  };

  return (
    <fieldset className="kb-form__fieldset" aria-label="Skills">
      <legend className="kb-form__label" style={{ marginBottom: 6 }}>
        Skills
      </legend>

      {/* Tagged skill chips */}
      {taggedSkills.length > 0 && (
        <div className="kb-skill-chips">
          {taggedSkills.map((skill) => (
            <span key={skill.id} className="kb-skill-chip" style={{ borderColor: `color-mix(in srgb, ${skill.accentColor} 40%, transparent)` }}>
              <span className="kb-skill-chip__icon">{skill.icon}</span>
              <span className="kb-skill-chip__name">{skill.name}</span>
              <button
                type="button"
                className="kb-skill-chip__remove"
                onClick={() => handleRemove(skill.id)}
                aria-label={`Remove skill: ${skill.name}`}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Skill variable inputs */}
      {taggedSkills.map((skill) =>
        skill.variables.length > 0 ? (
          <div key={skill.id} className="kb-skill-vars">
            <span className="kb-skill-vars__header">
              {skill.icon} {skill.name}
            </span>
            {skill.variables.map((v) => (
              <div key={v.name} className="kb-skill-vars__row">
                <label className="kb-form__label kb-form__label--sm" htmlFor={`skill-${skill.id}-${v.name}`}>
                  {v.label}
                  {v.required && <span className="kb-form__required">*</span>}
                </label>
                {v.type === "textarea" ? (
                  <textarea
                    id={`skill-${skill.id}-${v.name}`}
                    className="kb-form__textarea kb-form__textarea--sm"
                    placeholder={v.placeholder}
                    value={skillValues[skill.id]?.[v.name] ?? v.defaultValue ?? ""}
                    onChange={(e) => handleVarChange(skill.id, v.name, e.target.value)}
                    rows={2}
                  />
                ) : v.type === "select" ? (
                  <select
                    id={`skill-${skill.id}-${v.name}`}
                    className="kb-form__select"
                    value={skillValues[skill.id]?.[v.name] ?? v.defaultValue ?? ""}
                    onChange={(e) => handleVarChange(skill.id, v.name, e.target.value)}
                  >
                    {v.options?.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={`skill-${skill.id}-${v.name}`}
                    className="kb-form__input kb-form__input--sm"
                    placeholder={v.placeholder}
                    value={skillValues[skill.id]?.[v.name] ?? v.defaultValue ?? ""}
                    onChange={(e) => handleVarChange(skill.id, v.name, e.target.value)}
                  />
                )}
                {v.description && <span className="kb-form__help">{v.description}</span>}
              </div>
            ))}
          </div>
        ) : null,
      )}

      {/* Add skill dropdown */}
      <div className="kb-skill-add" style={{ position: "relative" }}>
        <button
          type="button"
          className="kb-btn kb-btn--ghost kb-btn--sm"
          onClick={() => setDropdownOpen((v) => !v)}
          aria-expanded={dropdownOpen}
          aria-haspopup="listbox"
        >
          + Add Skill
        </button>
        {dropdownOpen && categorized.length > 0 && (
          <div className="kb-skill-dropdown" role="listbox" aria-label="Available skills">
            {categorized.map((cat) => (
              <div key={cat.key}>
                <div className="kb-skill-dropdown__cat">{cat.label}</div>
                {cat.skills.map((skill) => (
                  <button
                    key={skill.id}
                    type="button"
                    className="kb-skill-dropdown__item"
                    onClick={() => handleAdd(skill.id)}
                    role="option"
                    aria-selected={false}
                  >
                    <span>{skill.icon}</span>
                    <span>{skill.name}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
        {dropdownOpen && categorized.length === 0 && (
          <div className="kb-skill-dropdown">
            <div className="kb-skill-dropdown__empty">No skills available</div>
          </div>
        )}
      </div>
    </fieldset>
  );
}

function CardForm({
  initial,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  initial?: CardFormData;
  onSubmit: (data: CardFormData) => void;
  onCancel: () => void;
  submitLabel: string;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [context, setContext] = useState(initial?.context ?? "");
  const [priority, setPriority] = useState<KanbanCard["priority"]>(
    initial?.priority ?? "medium",
  );
  const [subtasks, setSubtasks] = useState<KanbanSubtask[]>(
    initial?.subtasks ?? [],
  );
  const [newSubtask, setNewSubtask] = useState("");
  const [model, setModel] = useState<ModelOption>(initial?.model ?? "sonnet");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    initial?.permissionMode ?? "bypassPermissions",
  );
  const [worktreeIsolation, setWorktreeIsolation] = useState(
    initial?.worktreeIsolation ?? true,
  );
  const [skillIds, setSkillIds] = useState<string[]>(initial?.skillIds ?? []);
  const [skillValues, setSkillValues] = useState<Record<string, Record<string, string>>>(
    initial?.skillValues ?? {},
  );
  const [configExpanded, setConfigExpanded] = useState(false);

  useEscapeKey(onCancel, true);

  const handleAddSubtask = () => {
    const trimmed = newSubtask.trim();
    if (!trimmed) return;
    setSubtasks((prev) => [
      ...prev,
      { id: genId(), title: trimmed, done: false },
    ]);
    setNewSubtask("");
  };

  const handleSubmit = () => {
    if (!title.trim()) return;
    onSubmit({
      title: title.trim(),
      description,
      context,
      priority,
      subtasks,
      model,
      permissionMode,
      worktreeIsolation,
      skillIds,
      skillValues,
    });
  };

  const hasNonDefaultConfig =
    model !== "sonnet" ||
    permissionMode !== "bypassPermissions" ||
    !worktreeIsolation ||
    skillIds.length > 0;

  return (
    <form
      className="kb-form"
      onSubmit={(e) => {
        e.preventDefault();
        handleSubmit();
      }}
      role="form"
      aria-label="Card form"
    >
      <input
        className="kb-form__input"
        placeholder="Card title..."
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        autoFocus
        aria-label="Card title"
        required
      />
      <textarea
        className="kb-form__textarea"
        placeholder="Description (becomes the Leader prompt)..."
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={3}
        aria-label="Card description"
      />
      <textarea
        className="kb-form__textarea"
        placeholder="Context (file paths, constraints, links, etc.)..."
        value={context}
        onChange={(e) => setContext(e.target.value)}
        rows={2}
        aria-label="Context"
      />

      <div className="kb-form__row">
        <label className="kb-form__label" htmlFor="kb-priority">
          Priority
        </label>
        <select
          id="kb-priority"
          className="kb-form__select"
          value={priority}
          onChange={(e) =>
            setPriority(e.target.value as KanbanCard["priority"])
          }
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
      </div>

      {/* Subtasks */}
      <fieldset className="kb-form__fieldset" aria-label="Subtasks">
        <legend className="kb-form__label" style={{ marginBottom: 6 }}>
          Subtasks
        </legend>
        {subtasks.length > 0 && (
          <div className="kb-form__subtask-list">
            {subtasks.map((st) => (
              <div key={st.id} className="kb-form__subtask-item">
                <span>{st.title}</span>
                <button
                  type="button"
                  className="kb-btn kb-btn--icon"
                  onClick={() =>
                    setSubtasks((prev) => prev.filter((s) => s.id !== st.id))
                  }
                  aria-label={`Remove subtask: ${st.title}`}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="kb-form__subtask-add">
          <input
            className="kb-form__input"
            placeholder="New subtask..."
            value={newSubtask}
            onChange={(e) => setNewSubtask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleAddSubtask();
              }
            }}
            aria-label="New subtask text"
          />
          <button type="button" className="kb-btn kb-btn--ghost" onClick={handleAddSubtask} aria-label="Add subtask">
            +
          </button>
        </div>
      </fieldset>

      {/* Agent Configuration Section */}
      <div className="kb-form__config-section">
        <button
          type="button"
          className="kb-form__config-toggle"
          onClick={() => setConfigExpanded((v) => !v)}
          aria-expanded={configExpanded}
        >
          <ChevronIcon open={configExpanded} />
          <span>Agent Configuration</span>
          {hasNonDefaultConfig && (
            <span className="kb-form__config-badge" aria-label="Custom configuration">
              {[
                model !== "sonnet" ? MODEL_LABELS[model] : null,
                permissionMode !== "bypassPermissions" ? PERMISSION_LABELS[permissionMode] : null,
                !worktreeIsolation ? "No Worktree" : null,
                skillIds.length > 0 ? `${skillIds.length} skill${skillIds.length !== 1 ? "s" : ""}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
        </button>

        {configExpanded && (
          <div className="kb-form__config-body">
            {/* Model + Permission row */}
            <div className="kb-form__row">
              <label className="kb-form__label" htmlFor="kb-model">
                Model
              </label>
              <select
                id="kb-model"
                className="kb-form__select"
                value={model}
                onChange={(e) => setModel(e.target.value as ModelOption)}
              >
                <option value="sonnet">Sonnet</option>
                <option value="opus">Opus</option>
                <option value="haiku">Haiku</option>
              </select>
            </div>

            <div className="kb-form__row">
              <label className="kb-form__label" htmlFor="kb-permissions">
                Permissions
              </label>
              <select
                id="kb-permissions"
                className="kb-form__select"
                value={permissionMode}
                onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}
                title={PERMISSION_DESCRIPTIONS[permissionMode]}
              >
                {(Object.keys(PERMISSION_LABELS) as PermissionMode[]).map((mode) => (
                  <option key={mode} value={mode} title={PERMISSION_DESCRIPTIONS[mode]}>
                    {PERMISSION_LABELS[mode]}
                  </option>
                ))}
              </select>
            </div>

            {/* Worktree toggle */}
            <div className="kb-form__row">
              <label className="kb-form__label" htmlFor="kb-worktree">
                Worktree Isolation
              </label>
              <button
                id="kb-worktree"
                type="button"
                className={cx("kb-toggle", worktreeIsolation && "kb-toggle--on")}
                onClick={() => setWorktreeIsolation((v) => !v)}
                role="switch"
                aria-checked={worktreeIsolation}
                aria-label="Worktree isolation"
              >
                <span className="kb-toggle__thumb" />
              </button>
            </div>

            {/* Skills picker */}
            <SkillPicker
              skillIds={skillIds}
              skillValues={skillValues}
              onUpdate={(ids, vals) => {
                setSkillIds(ids);
                setSkillValues(vals);
              }}
            />
          </div>
        )}
      </div>

      <div className="kb-form__actions">
        <button type="button" className="kb-btn kb-btn--ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="kb-btn kb-btn--primary" disabled={!title.trim()}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

// ─── Shared Micro-Components ──────────────────────────────

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <span className={cx("kb-card__chevron", open && "kb-card__chevron--open")}>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
        <path d="M2.5 3.75L5 6.25L7.5 3.75" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function SubtaskBadge({ done, total }: { done: number; total: number }) {
  if (total === 0) return null;
  return (
    <span
      className={cx("kb-card__subtask-count", done === total && "kb-card__subtask-count--done")}
      aria-label={`${done} of ${total} subtasks done`}
    >
      {done}/{total}
    </span>
  );
}

function DeleteConfirm({
  cardTitle,
  onConfirm,
  onCancel,
}: {
  cardTitle: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEscapeKey(onCancel, true);
  useClickOutside(ref, onCancel, true);

  return (
    <div className="kb-confirm-backdrop">
      <div ref={ref} className="kb-confirm" role="alertdialog" aria-label="Confirm delete" aria-describedby="kb-confirm-desc">
        <p id="kb-confirm-desc" className="kb-confirm__text">
          Delete <strong>{cardTitle}</strong>?
        </p>
        <div className="kb-confirm__actions">
          <button className="kb-btn kb-btn--ghost" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button className="kb-btn kb-btn--danger" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function EditPopover({
  card,
  dispatch,
  onClose,
}: {
  card: KanbanCard;
  dispatch: Dispatch<KanbanAction>;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  useClickOutside(popoverRef, onClose, true);

  return (
    <div className="kb-popover-backdrop">
      <div ref={popoverRef} className="kb-edit-popover" role="dialog" aria-label={`Edit ${card.title}`}>
        <div className="kb-edit-popover__header">
          <span className="kb-edit-popover__title">Edit Card</span>
          <button className="kb-btn kb-btn--icon" onClick={onClose} aria-label="Close">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <CardForm
          initial={{
            title: card.title,
            description: card.description,
            context: card.context,
            priority: card.priority,
            subtasks: card.subtasks,
            model: card.model ?? "sonnet",
            permissionMode: card.permissionMode ?? "bypassPermissions",
            worktreeIsolation: card.worktreeIsolation ?? true,
            skillIds: card.skillIds ?? [],
            skillValues: card.skillValues ?? {},
          }}
          submitLabel="Save"
          onCancel={onClose}
          onSubmit={(data) => {
            dispatch({
              type: "UPDATE_CARD",
              cardId: card.id,
              data: {
                title: data.title,
                description: data.description,
                context: data.context,
                priority: data.priority,
                subtasks: data.subtasks,
                model: data.model,
                permissionMode: data.permissionMode,
                worktreeIsolation: data.worktreeIsolation,
                skillIds: data.skillIds,
                skillValues: data.skillValues,
              },
            });
            onClose();
          }}
        />
      </div>
    </div>
  );
}

// ─── Backlog Card ────────────────────────────────────────

function BacklogCard({
  card,
  dispatch,
  onLaunchLeader,
}: {
  card: KanbanCard;
  dispatch: Dispatch<KanbanAction>;
  onLaunchLeader: (card: KanbanCard) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const doneCount = card.subtasks.filter((s) => s.done).length;
  const totalCount = card.subtasks.length;

  const closeExpand = useCallback(() => setExpanded(false), []);
  useEscapeKey(closeExpand, expanded && !editing && !confirmDelete);
  useScrollIntoView(bodyRef, expanded);

  const cardModel = card.model ?? "sonnet";
  const cardPermission = card.permissionMode ?? "bypassPermissions";
  const cardWorktree = card.worktreeIsolation ?? true;
  const cardSkillIds = card.skillIds ?? [];
  const taggedSkills = cardSkillIds
    .map((id) => getSkill(id))
    .filter((s): s is SkillTemplate => s !== undefined);

  return (
    <>
      <article
        className={cx("kb-card", `kb-card--${card.priority}`)}
        aria-label={`${card.title} - ${PRIORITY_LABELS[card.priority]} priority`}
      >
        <div
          className="kb-card__header"
          onClick={() => setExpanded((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded((v) => !v); }
          }}
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
        >
          <span className="kb-card__title">{card.title}</span>
          <SubtaskBadge done={doneCount} total={totalCount} />
          <ChevronIcon open={expanded} />
        </div>

        {/* Config chips row — always visible when non-default */}
        {(cardModel !== "sonnet" || cardPermission !== "bypassPermissions" || !cardWorktree || taggedSkills.length > 0) && (
          <div className="kb-card__config-chips">
            {cardModel !== "sonnet" && (
              <span className="kb-config-chip kb-config-chip--model">{MODEL_LABELS[cardModel]}</span>
            )}
            {cardPermission !== "bypassPermissions" && (
              <span className="kb-config-chip kb-config-chip--perm">{PERMISSION_LABELS[cardPermission]}</span>
            )}
            {!cardWorktree && (
              <span className="kb-config-chip kb-config-chip--worktree">No Worktree</span>
            )}
            {taggedSkills.map((skill) => (
              <span key={skill.id} className="kb-config-chip kb-config-chip--skill" style={{ borderColor: `color-mix(in srgb, ${skill.accentColor} 40%, transparent)` }}>
                {skill.icon} {skill.name}
              </span>
            ))}
          </div>
        )}

        {expanded && (
          <div ref={bodyRef} className="kb-card__body" onClick={(e) => e.stopPropagation()}>
            {card.description && <div className="kb-card__desc">{card.description}</div>}
            {card.context && <div className="kb-card__context">{card.context}</div>}

            {card.subtasks.length > 0 && (
              <ul className="kb-subtasks" aria-label="Subtasks">
                {card.subtasks.map((st) => (
                  <li key={st.id} className="kb-subtask">
                    <span className="kb-subtask__bullet" aria-hidden="true">&#8226;</span>
                    {st.title}
                  </li>
                ))}
              </ul>
            )}

            <div className="kb-card__actions">
              <button className="kb-btn kb-btn--primary" onClick={() => onLaunchLeader(card)} aria-label={`Launch ${card.title}`}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <path d="M2 1.5L8.5 5L2 8.5V1.5Z" fill="currentColor" />
                </svg>
                Launch
              </button>
              <button className="kb-btn kb-btn--ghost" onClick={() => setEditing(true)} aria-label={`Edit ${card.title}`}>
                Edit
              </button>
              <button className="kb-btn kb-btn--danger-ghost" onClick={() => setConfirmDelete(true)} aria-label={`Delete ${card.title}`}>
                Del
              </button>
            </div>
          </div>
        )}
      </article>

      {editing && <EditPopover card={card} dispatch={dispatch} onClose={() => setEditing(false)} />}
      {confirmDelete && (
        <DeleteConfirm
          cardTitle={card.title}
          onConfirm={() => { dispatch({ type: "REMOVE_CARD", cardId: card.id }); setConfirmDelete(false); }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
}

// ─── In Progress Card ────────────────────────────────────

interface LeaderStatus {
  status: string;
  worktreeStatus: string;
  cost: number;
  turns: number;
}

function InProgressCard({
  card,
  leaderStatus,
  onFocusNode,
}: {
  card: KanbanCard;
  leaderStatus?: LeaderStatus;
  onFocusNode?: (nodeId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const doneCount = card.subtasks.filter((s) => s.done).length;
  const totalCount = card.subtasks.length;

  const closeExpand = useCallback(() => setExpanded(false), []);
  useEscapeKey(closeExpand, expanded);
  useScrollIntoView(bodyRef, expanded);

  let dotClass: string;
  let statusText: string;

  if (!leaderStatus) {
    dotClass = "kb-status__dot--waiting";
    statusText = "Waiting...";
  } else if (leaderStatus.status === "running" || leaderStatus.status === "creating") {
    dotClass = "kb-status__dot--running";
    statusText = leaderStatus.status === "creating" ? "Starting..." : "Running...";
  } else if (leaderStatus.status === "idle" && leaderStatus.worktreeStatus !== "active") {
    dotClass = "kb-status__dot--idle";
    statusText = "Idle";
  } else {
    dotClass = "kb-status__dot--working";
    statusText = "Working...";
  }

  return (
    <article className={cx("kb-card", `kb-card--${card.priority}`)} aria-label={`${card.title} - In progress`}>
      <div
        className="kb-card__header"
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded((v) => !v); }
        }}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
      >
        <span className="kb-card__title">{card.title}</span>
        <SubtaskBadge done={doneCount} total={totalCount} />
        <ChevronIcon open={expanded} />
      </div>

      {/* Live status — always visible */}
      <div className="kb-status" aria-live="polite">
        <span className={cx("kb-status__dot", dotClass)} aria-hidden="true" />
        <span className="kb-status__text">{statusText}</span>
        {leaderStatus && leaderStatus.cost > 0 && (
          <span className="kb-status__cost">${leaderStatus.cost.toFixed(2)}</span>
        )}
        {card.leaderNodeId && onFocusNode && (
          <button
            className="kb-btn kb-btn--link"
            onClick={(e) => { e.stopPropagation(); onFocusNode(card.leaderNodeId!); }}
            aria-label="View on Canvas"
          >
            View
          </button>
        )}
      </div>

      {expanded && (
        <div ref={bodyRef} className="kb-card__body" onClick={(e) => e.stopPropagation()}>
          {card.description && <div className="kb-card__desc">{card.description}</div>}
          {card.context && <div className="kb-card__context">{card.context}</div>}

          {card.subtasks.length > 0 && (
            <ul className="kb-subtasks" aria-label="Subtasks">
              {card.subtasks.map((st) => (
                <li key={st.id} className={cx("kb-subtask", st.done && "kb-subtask--done")}>
                  <span className={cx("kb-subtask__bullet", st.done && "kb-subtask__bullet--done")} aria-hidden="true">
                    {st.done ? "\u2713" : "\u2022"}
                  </span>
                  {st.title}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

// ─── Review Card ─────────────────────────────────────────

function ReviewCard({
  card,
  onCloseCard,
  onFocusNode,
}: {
  card: KanbanCard;
  onCloseCard: (card: KanbanCard) => void;
  onFocusNode?: (nodeId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const closeExpand = useCallback(() => setExpanded(false), []);
  useEscapeKey(closeExpand, expanded);
  useScrollIntoView(bodyRef, expanded);

  return (
    <article className={cx("kb-card", `kb-card--${card.priority}`)} aria-label={`${card.title} - Ready for review`}>
      <div
        className="kb-card__header"
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded((v) => !v); }
        }}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
      >
        <span className="kb-card__title">{card.title}</span>
        <span className="kb-badge--review">Review</span>
        <ChevronIcon open={expanded} />
      </div>

      {expanded && (
        <div ref={bodyRef} className="kb-card__body" onClick={(e) => e.stopPropagation()}>
          {card.description && <div className="kb-card__desc">{card.description}</div>}
          {card.agentSummary && <div className="kb-card__summary">{card.agentSummary}</div>}

          <div className="kb-card__actions">
            <button className="kb-btn kb-btn--success" onClick={() => onCloseCard(card)} aria-label={`Close ${card.title}`}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <path d="M2 5.5L4 7.5L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Close Card
            </button>
            {card.leaderNodeId && onFocusNode && (
              <button className="kb-btn kb-btn--ghost" onClick={() => onFocusNode(card.leaderNodeId!)} aria-label="View on Canvas">
                View
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

// ─── History Card ────────────────────────────────────────

function HistoryCard({ card }: { card: KanbanCard }) {
  const [expanded, setExpanded] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const closeExpand = useCallback(() => setExpanded(false), []);
  useEscapeKey(closeExpand, expanded);
  useScrollIntoView(bodyRef, expanded);

  return (
    <article className={cx("kb-card", "kb-card--history", `kb-card--${card.priority}`)} aria-label={`${card.title} - Completed`}>
      <div
        className="kb-card__header"
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded((v) => !v); }
        }}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
      >
        <span className="kb-card__title">{card.title}</span>
        {card.agentCost != null && card.agentCost > 0 && (
          <span className="kb-card__subtask-count">${card.agentCost.toFixed(2)}</span>
        )}
        <ChevronIcon open={expanded} />
      </div>

      {expanded && (
        <div ref={bodyRef} className="kb-card__body" onClick={(e) => e.stopPropagation()}>
          {card.agentSummary && <div className="kb-card__summary">{card.agentSummary}</div>}
          {card.agentCost != null && (
            <div className="kb-cost">
              <span className="kb-cost__label">Total cost:</span>
              <span>${card.agentCost.toFixed(2)}</span>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

// ─── Column Component ─────────────────────────────────────

function KanbanColumnComponent({
  column,
  cards,
  dispatch,
  onLaunchLeader,
  onCloseCard,
  leaderStatuses,
  onFocusNode,
}: {
  column: { id: string; title: string; color: string };
  cards: KanbanCard[];
  dispatch: Dispatch<KanbanAction>;
  onLaunchLeader: (card: KanbanCard) => void;
  onCloseCard: (card: KanbanCard) => void;
  leaderStatuses: Map<string, LeaderStatus>;
  onFocusNode?: (nodeId: string) => void;
}) {
  return (
    <section className="kb-column" aria-label={`${column.title} column`}>
      <header className="kb-column__header">
        <span className="kb-column__icon" style={{ background: column.color }} aria-hidden="true" />
        <h3 className="kb-column__title">{column.title}</h3>
        <span className="kb-column__count" aria-label={`${cards.length} cards`}>
          {cards.length}
        </span>
      </header>

      <div className="kb-column__cards" role="list">
        {cards.length === 0 ? (
          <div className="kb-empty" aria-label="No cards">
            <span className="kb-empty__icon" aria-hidden="true">{"\u2014"}</span>
            <span>No cards</span>
          </div>
        ) : (
          cards.map((card) => {
            switch (column.id) {
              case "backlog":
                return <BacklogCard key={card.id} card={card} dispatch={dispatch} onLaunchLeader={onLaunchLeader} />;
              case "in-progress":
                return (
                  <InProgressCard
                    key={card.id}
                    card={card}
                    leaderStatus={card.leaderNodeId ? leaderStatuses.get(card.leaderNodeId) : undefined}
                    onFocusNode={onFocusNode}
                  />
                );
              case "review":
                return <ReviewCard key={card.id} card={card} onCloseCard={onCloseCard} onFocusNode={onFocusNode} />;
              case "history":
                return <HistoryCard key={card.id} card={card} />;
              default:
                return null;
            }
          })
        )}
      </div>
    </section>
  );
}

// ─── Main Board Component ─────────────────────────────────

interface KanbanBoardProps {
  board: KanbanBoardType;
  dispatch: Dispatch<KanbanAction>;
  onLaunchLeader: (card: KanbanCard) => void;
  leaderStatuses: Map<string, LeaderStatus>;
  onCloseCard: (card: KanbanCard) => void;
  onFocusNode?: (nodeId: string) => void;
  socketSend: (data: unknown) => void;
  socketSubscribe: (fn: (msg: ServerMessage) => void) => () => void;
  projectPath: string;
}

export function KanbanBoard({
  board,
  dispatch,
  onLaunchLeader,
  leaderStatuses,
  onCloseCard,
  onFocusNode,
  socketSend,
  socketSubscribe,
  projectPath,
}: KanbanBoardProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const addPopupRef = useRef<HTMLDivElement>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);

  const totalCards = board.cards.length;

  const closeAdd = useCallback(() => setShowAddForm(false), []);
  useClickOutside(addPopupRef, closeAdd, showAddForm);
  useEscapeKey(closeAdd, showAddForm);

  const handleAddCard = useCallback(
    (data: CardFormData) => {
      const card: KanbanCard = {
        id: genId(),
        title: data.title,
        description: data.description,
        context: data.context,
        priority: data.priority,
        subtasks: data.subtasks,
        model: data.model,
        permissionMode: data.permissionMode,
        worktreeIsolation: data.worktreeIsolation,
        skillIds: data.skillIds,
        skillValues: data.skillValues,
        columnId: "backlog",
        createdAt: Date.now(),
      };
      dispatch({ type: "ADD_CARD", card });
      setShowAddForm(false);
      addBtnRef.current?.focus();
    },
    [dispatch],
  );

  // Column summary chips
  const columnSummary = board.columns.map((col) => ({
    id: col.id,
    title: col.title,
    color: col.color,
    count: board.cards.filter((c) => c.columnId === col.id).length,
  }));

  return (
    <div className="kb-root">
      {/* Toolbar */}
      <div className="kb-toolbar">
        <div className="kb-toolbar__left">
          <span className="kb-toolbar__count">
            {totalCards} task{totalCards !== 1 ? "s" : ""}
          </span>
          <div className="kb-toolbar__chips">
            {columnSummary.map((col) => (
              <span
                key={col.id}
                className="kb-toolbar__chip"
                style={{
                  color: col.color,
                  borderColor: `color-mix(in srgb, ${col.color} 25%, transparent)`,
                  background: `color-mix(in srgb, ${col.color} 8%, transparent)`,
                }}
              >
                <span className="kb-toolbar__chip-dot" style={{ background: col.color }} />
                {col.count}
              </span>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", gap: "var(--kb-space-sm)" }}>
          <button
            className={cx("kb-btn", showChat ? "kb-btn--ghost" : "kb-btn--secondary", "kb-toolbar__chat-btn")}
            onClick={() => { setShowChat((v) => !v); if (showAddForm) setShowAddForm(false); }}
            aria-expanded={showChat}
            aria-haspopup="dialog"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M2 2.5A2.5 2.5 0 014.5 0h7A2.5 2.5 0 0114 2.5v8a2.5 2.5 0 01-2.5 2.5H6l-3 3v-3H2.5A2.5 2.5 0 010 10.5v-8z"
                fill="currentColor"
                opacity="0.8"
              />
            </svg>
            {showChat ? "Close Chat" : "AI Create"}
          </button>
          <button
            ref={addBtnRef}
            className={cx("kb-btn", showAddForm ? "kb-btn--ghost" : "kb-btn--primary")}
            onClick={() => setShowAddForm((v) => !v)}
            aria-expanded={showAddForm}
            aria-haspopup="dialog"
          >
            {showAddForm ? "Cancel" : "+ Add Card"}
          </button>
        </div>
      </div>

      {/* Add card popup */}
      {showAddForm && (
        <div ref={addPopupRef} className="kb-add-popup" role="dialog" aria-label="Add card" aria-modal="false">
          <CardForm
            submitLabel="Add Card"
            onSubmit={handleAddCard}
            onCancel={() => { setShowAddForm(false); addBtnRef.current?.focus(); }}
          />
        </div>
      )}

      {/* Main content area: columns + optional chat panel */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Columns */}
        <div className="kb-columns" style={{ flex: 1, minWidth: 0 }}>
          {board.columns.map((col) => {
            const columnCards = board.cards.filter((c) => c.columnId === col.id);
            return (
              <KanbanColumnComponent
                key={col.id}
                column={col}
                cards={columnCards}
                dispatch={dispatch}
                onLaunchLeader={onLaunchLeader}
                onCloseCard={onCloseCard}
                leaderStatuses={leaderStatuses}
                onFocusNode={onFocusNode}
              />
            );
          })}
        </div>

        {/* Card Creation Chat Panel */}
        {showChat && (
          <CardCreationChat
            dispatch={dispatch}
            socketSend={socketSend}
            socketSubscribe={socketSubscribe}
            onClose={() => setShowChat(false)}
            projectPath={projectPath}
          />
        )}
      </div>
    </div>
  );
}
