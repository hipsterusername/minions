import { useState, useCallback, useEffect, useRef, useMemo, type Dispatch } from "react";
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
import type { CanvasNode } from "./types.ts";
import type { ProjectSettings } from "./api.ts";
import type { LeaderData, TaskPlanItem } from "./nodes/LeaderNode.tsx";
import type { DisplayMessage } from "./sdk-messages.ts";
import { msgId } from "./sdk-messages.ts";
import { LEADER_SYSTEM_PROMPT } from "./prompts/leader-system.ts";
import { compileSkills } from "./skills/types.ts";
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
  linkedContextNodeIds: string[];
}

const MODEL_LABELS: Record<ModelOption, string> = {
  sonnet: "Sonnet",
  opus: "Opus",
  haiku: "Haiku",
};

const PERMISSION_LABELS: Record<PermissionMode, string> = {
  auto: "Auto",
  bypassPermissions: "Bypass",
  default: "Default",
  plan: "Plan",
  acceptEdits: "Accept Edits",
};

const PERMISSION_DESCRIPTIONS: Record<PermissionMode, string> = {
  auto: "Auto-approve safe operations",
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
    // Keep dropdown open so user can add multiple skills without re-clicking
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

/** Context node info for the linked-context picker */
interface ContextNodeOption {
  id: string;
  type: string;
  label: string;
}

function CardForm({
  initial,
  onSubmit,
  onCancel,
  submitLabel,
  contextNodes,
  defaultWorktreeIsolation,
}: {
  initial?: CardFormData;
  onSubmit: (data: CardFormData) => void;
  onCancel: () => void;
  submitLabel: string;
  contextNodes?: ContextNodeOption[];
  defaultWorktreeIsolation?: boolean;
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
    initial?.permissionMode ?? "auto",
  );
  const [worktreeIsolation, setWorktreeIsolation] = useState(
    initial?.worktreeIsolation ?? (defaultWorktreeIsolation !== false),
  );
  const [skillIds, setSkillIds] = useState<string[]>(initial?.skillIds ?? []);
  const [skillValues, setSkillValues] = useState<Record<string, Record<string, string>>>(
    initial?.skillValues ?? {},
  );
  const [linkedContextNodeIds, setLinkedContextNodeIds] = useState<string[]>(
    initial?.linkedContextNodeIds ?? [],
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
      linkedContextNodeIds,
    });
  };

  const hasNonDefaultConfig =
    model !== "sonnet" ||
    permissionMode !== "auto" ||
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

      {/* Linked context nodes */}
      {contextNodes && contextNodes.length > 0 && (
        <fieldset className="kb-form__fieldset" aria-label="Linked context nodes">
          <legend className="kb-form__label" style={{ marginBottom: 6 }}>
            Linked Context Nodes
          </legend>
          <div className="kb-linked-context-list">
            {contextNodes.map((cn) => {
              const isLinked = linkedContextNodeIds.includes(cn.id);
              return (
                <button
                  key={cn.id}
                  type="button"
                  className={cx("kb-linked-context-chip", isLinked && "kb-linked-context-chip--active")}
                  onClick={() =>
                    setLinkedContextNodeIds((prev) =>
                      isLinked ? prev.filter((id) => id !== cn.id) : [...prev, cn.id],
                    )
                  }
                  aria-pressed={isLinked}
                  title={`${cn.type === "markdown" ? "Markdown" : "File"}: ${cn.label}`}
                >
                  <span className="kb-linked-context-chip__icon">
                    {cn.type === "markdown" ? "📝" : "📄"}
                  </span>
                  <span className="kb-linked-context-chip__label">{cn.label}</span>
                </button>
              );
            })}
          </div>
        </fieldset>
      )}

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
                permissionMode !== "auto" ? PERMISSION_LABELS[permissionMode] : null,
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

// ─── Backlog Card ────────────────────────────────────────

function BacklogCard({
  card,
  dispatch,
  onLaunchLeader,
  onSelect,
  isSelected,
  contextNodes,
}: {
  card: KanbanCard;
  dispatch: Dispatch<KanbanAction>;
  onLaunchLeader: (card: KanbanCard) => void;
  onSelect: (cardId: string) => void;
  isSelected: boolean;
  contextNodes?: ContextNodeOption[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const doneCount = card.subtasks.filter((s) => s.done).length;
  const totalCount = card.subtasks.length;

  const closeExpand = useCallback(() => setExpanded(false), []);
  useEscapeKey(closeExpand, expanded && !confirmDelete);
  useScrollIntoView(bodyRef, expanded);

  const cardModel = card.model ?? "sonnet";
  const cardPermission = card.permissionMode ?? "auto";
  const cardWorktree = card.worktreeIsolation ?? true;
  const cardSkillIds = card.skillIds ?? [];
  const taggedSkills = cardSkillIds
    .map((id) => getSkill(id))
    .filter((s): s is SkillTemplate => s !== undefined);

  return (
    <>
      <article
        className={cx("kb-card", `kb-card--${card.priority}`, isSelected && "kb-card--selected")}
        aria-label={`${card.title} - ${PRIORITY_LABELS[card.priority]} priority`}
        onClick={() => onSelect(card.id)}
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
        {(cardModel !== "sonnet" || cardPermission !== "auto" || !cardWorktree || taggedSkills.length > 0) && (
          <div className="kb-card__config-chips">
            {cardModel !== "sonnet" && (
              <span className="kb-config-chip kb-config-chip--model">{MODEL_LABELS[cardModel]}</span>
            )}
            {cardPermission !== "auto" && (
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

            {(card.linkedContextNodeIds ?? []).length > 0 && (
              <div className="kb-card__linked-context">
                {(card.linkedContextNodeIds ?? []).map((nid) => {
                  const cn = contextNodes?.find((c) => c.id === nid);
                  if (!cn) return <span key={nid} className="kb-linked-context-tag kb-linked-context-tag--missing">removed node</span>;
                  return (
                    <span key={nid} className="kb-linked-context-tag">
                      {cn.type === "markdown" ? "📝" : "📄"} {cn.label}
                    </span>
                  );
                })}
              </div>
            )}

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
              <button className="kb-btn kb-btn--danger-ghost" onClick={() => setConfirmDelete(true)} aria-label={`Delete ${card.title}`}>
                Del
              </button>
            </div>
          </div>
        )}
      </article>

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
  dispatch,
  leaderStatus,
  onFocusNode,
  onSelect,
  isSelected,
}: {
  card: KanbanCard;
  dispatch: Dispatch<KanbanAction>;
  leaderStatus?: LeaderStatus;
  onFocusNode?: (nodeId: string) => void;
  onSelect: (cardId: string) => void;
  isSelected: boolean;
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
    <article className={cx("kb-card", `kb-card--${card.priority}`, isSelected && "kb-card--selected")} aria-label={`${card.title} - In progress`} onClick={() => onSelect(card.id)}>
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
        {card.autoSynced && (
          <span className="kb-badge--auto-synced" title="Auto-tracked from canvas">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="1" y="1" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
              <circle cx="5.5" cy="5.5" r="1.5" fill="currentColor" />
              <circle cx="10.5" cy="10.5" r="1.5" fill="currentColor" />
              <path d="M7 5.5h3.5V7" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
              <path d="M9 10.5H5.5V9" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
            </svg>
            canvas
          </span>
        )}
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

          {(card.linkedContextNodeIds ?? []).length > 0 && (
            <div className="kb-card__linked-context">
              {(card.linkedContextNodeIds ?? []).map((nid) => (
                <span key={nid} className="kb-linked-context-tag">
                  📎 linked context
                </span>
              ))}
            </div>
          )}

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

// ─── Block Reason Labels ─────────────────────────────────

const BLOCK_REASON_LABELS: Record<string, { label: string; icon: string; color: string }> = {
  session_lost: { label: "Session lost", icon: "\u26A0", color: "var(--status-warning)" },
  error: { label: "Error", icon: "\u2717", color: "var(--danger-color)" },
  interrupted: { label: "Interrupted", icon: "\u23F8", color: "var(--status-warning)" },
  needs_input: { label: "Needs input", icon: "\u2753", color: "var(--accent)" },
  idle_review: { label: "Ready for review", icon: "\u2713", color: "var(--info-color)" },
};

// ─── Halted Card ────────────────────────────────────────

function HaltedCard({
  card,
  dispatch,
  onResume,
  onCloseCard,
  onFocusNode,
  onSelect,
  isSelected,
}: {
  card: KanbanCard;
  dispatch: Dispatch<KanbanAction>;
  onResume: (card: KanbanCard) => void;
  onCloseCard: (card: KanbanCard) => void;
  onFocusNode?: (nodeId: string) => void;
  onSelect: (cardId: string) => void;
  isSelected: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closeExpand = useCallback(() => setExpanded(false), []);
  useEscapeKey(closeExpand, expanded);
  useScrollIntoView(bodyRef, expanded);

  const reason = card.blockReason ?? "session_lost";
  const info = BLOCK_REASON_LABELS[reason] ?? BLOCK_REASON_LABELS.session_lost;

  return (
    <article className={cx("kb-card", "kb-card--halted", `kb-card--${card.priority}`, isSelected && "kb-card--selected")} aria-label={`${card.title} - Halted`} onClick={() => onSelect(card.id)}>
      <div
        className="kb-card__header"
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded((v) => !v); } }}
        role="button" tabIndex={0} aria-expanded={expanded}
      >
        <span className="kb-card__title">{card.title}</span>
        {card.autoSynced && (
          <span className="kb-badge--auto-synced" title="Auto-tracked from canvas">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="1" y="1" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
              <circle cx="5.5" cy="5.5" r="1.5" fill="currentColor" />
              <circle cx="10.5" cy="10.5" r="1.5" fill="currentColor" />
              <path d="M7 5.5h3.5V7" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
              <path d="M9 10.5H5.5V9" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
            </svg>
          </span>
        )}
        <span className="kb-badge--halted">{info.icon} {info.label}</span>
        <ChevronIcon open={expanded} />
      </div>

      {card.blockDetail && (
        <div className="kb-halted__detail" aria-live="polite">{card.blockDetail}</div>
      )}

      {expanded && (
        <div ref={bodyRef} className="kb-card__body" onClick={(e) => e.stopPropagation()}>
          {card.description && <div className="kb-card__desc">{card.description}</div>}
          <div className="kb-card__actions">
            {reason !== "idle_review" ? (
              <>
                <button className="kb-btn kb-btn--primary" onClick={() => onResume(card)}>
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 2L8 5L3 8Z" fill="currentColor"/></svg>
                  Resume
                </button>
                <button className="kb-btn kb-btn--ghost" onClick={() => onCloseCard(card)}>Close Card</button>
              </>
            ) : (
              <button className="kb-btn kb-btn--success" onClick={() => onCloseCard(card)}>Approve & Close</button>
            )}
            {card.leaderNodeId && onFocusNode && (
              <button className="kb-btn kb-btn--ghost" onClick={() => onFocusNode(card.leaderNodeId!)}>View</button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

// ─── History Card ────────────────────────────────────────

function HistoryCard({
  card,
  dispatch,
  onSelect,
  isSelected,
  onLaunchLeader,
}: {
  card: KanbanCard;
  dispatch: Dispatch<KanbanAction>;
  onSelect: (cardId: string) => void;
  isSelected: boolean;
  onLaunchLeader: (card: KanbanCard) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const closeExpand = useCallback(() => setExpanded(false), []);
  useEscapeKey(closeExpand, expanded);
  useScrollIntoView(bodyRef, expanded);

  return (
    <article className={cx("kb-card", "kb-card--history", `kb-card--${card.priority}`, isSelected && "kb-card--selected")} aria-label={`${card.title} - Agent History`} onClick={() => onSelect(card.id)}>
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
        <span className="kb-card__done-check" aria-hidden="true">{"\u2713"}</span>
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
          <div className="kb-card__actions">
            <button
              className="kb-btn kb-btn--primary"
              onClick={() => onLaunchLeader(card)}
              aria-label={`Attach ${card.title} to canvas`}
            >
              Attach to Canvas
            </button>
            <button
              className="kb-btn kb-btn--danger-ghost"
              onClick={() => dispatch({ type: "REMOVE_CARD", cardId: card.id })}
              aria-label={`Remove ${card.title}`}
            >
              Remove
            </button>
          </div>
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
  onResume,
  leaderStatuses,
  onFocusNode,
  headerActions,
  belowHeader,
  selectedCardId,
  onSelectCard,
  extraClassName,
  contextNodes,
}: {
  column: { id: string; title: string; color: string };
  cards: KanbanCard[];
  dispatch: Dispatch<KanbanAction>;
  onLaunchLeader: (card: KanbanCard) => void;
  onCloseCard: (card: KanbanCard) => void;
  onResume: (card: KanbanCard) => void;
  leaderStatuses: Map<string, LeaderStatus>;
  contextNodes: ContextNodeOption[];
  onFocusNode?: (nodeId: string) => void;
  headerActions?: React.ReactNode;
  belowHeader?: React.ReactNode;
  selectedCardId: string | null;
  onSelectCard: (cardId: string) => void;
  extraClassName?: string;
}) {
  return (
    <section className={cx("kb-column", extraClassName)} aria-label={`${column.title} column`}>
      <header className="kb-column__header">
        <span className="kb-column__icon" style={{ background: column.color }} aria-hidden="true" />
        <h3 className="kb-column__title">{column.title}</h3>
        <span className="kb-column__count" aria-label={`${cards.length} cards`}>
          {cards.length}
        </span>
        {headerActions}
      </header>
      {belowHeader}

      <div className="kb-column__cards" role="list">
        {cards.length === 0 ? (
          <div className="kb-empty" aria-label="No cards">
            <span className="kb-empty__icon" aria-hidden="true">{"\u2014"}</span>
            <span>No cards</span>
          </div>
        ) : (
          cards.map((card) => {
            const isSelected = card.id === selectedCardId;
            switch (column.id) {
              case "backlog":
                return <BacklogCard key={card.id} card={card} dispatch={dispatch} onLaunchLeader={onLaunchLeader} onSelect={onSelectCard} isSelected={isSelected} contextNodes={contextNodes} />;
              case "in-progress":
                return (
                  <InProgressCard
                    key={card.id}
                    card={card}
                    dispatch={dispatch}
                    leaderStatus={card.leaderNodeId ? leaderStatuses.get(card.leaderNodeId) : undefined}
                    onFocusNode={onFocusNode}
                    onSelect={onSelectCard}
                    isSelected={isSelected}
                  />
                );
              case "halted":
                return <HaltedCard key={card.id} card={card} dispatch={dispatch} onResume={onResume} onCloseCard={onCloseCard} onFocusNode={onFocusNode} onSelect={onSelectCard} isSelected={isSelected} />;
              case "history":
                return <HistoryCard key={card.id} card={card} dispatch={dispatch} onSelect={onSelectCard} isSelected={isSelected} onLaunchLeader={onLaunchLeader} />;
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

// ─── Priority Badge ──────────────────────────────────────

function PriorityBadge({ priority }: { priority: KanbanCard["priority"] }) {
  return (
    <span
      className="kb-badge--blocked"
      style={{
        color: `var(--kb-priority-${priority})`,
        borderColor: `color-mix(in srgb, var(--kb-priority-${priority}) 30%, transparent)`,
        background: `color-mix(in srgb, var(--kb-priority-${priority}) 10%, transparent)`,
        flexShrink: 0,
      }}
    >
      {PRIORITY_LABELS[priority]}
    </span>
  );
}

const COLUMN_BADGE_MAP: Record<string, { label: string; color: string }> = {
  backlog: { label: "Backlog", color: "var(--priority-low)" },
  "in-progress": { label: "In Progress", color: "var(--status-warning)" },
  halted: { label: "Waiting", color: "var(--status-warning)" },
  history: { label: "Agent History", color: "var(--status-success)" },
};

function ColumnBadge({ columnId, blockReason }: { columnId: string; blockReason?: string }) {
  if (columnId === "halted" && blockReason) {
    const info = BLOCK_REASON_LABELS[blockReason] ?? BLOCK_REASON_LABELS.session_lost;
    return (
      <span
        className="kb-badge--blocked"
        style={{
          color: info.color,
          borderColor: `color-mix(in srgb, ${info.color} 30%, transparent)`,
          background: `color-mix(in srgb, ${info.color} 10%, transparent)`,
        }}
      >
        {info.icon} {info.label}
      </span>
    );
  }
  const badge = COLUMN_BADGE_MAP[columnId] ?? { label: columnId, color: "var(--priority-low)" };
  return (
    <span
      className="kb-badge--blocked"
      style={{
        color: badge.color,
        borderColor: `color-mix(in srgb, ${badge.color} 30%, transparent)`,
        background: `color-mix(in srgb, ${badge.color} 10%, transparent)`,
      }}
    >
      {badge.label}
    </span>
  );
}

// ─── Persistent Inspector Panel ─────────────────────────

type InspectorTab = "activity" | "config";

function InspectorTabBar({
  activeTab,
  onChange,
  hasActivity,
}: {
  activeTab: InspectorTab;
  onChange: (tab: InspectorTab) => void;
  hasActivity: boolean;
}) {
  const tabs: { id: InspectorTab; label: string; hasIndicator?: boolean }[] = [
    { id: "activity", label: "Activity", hasIndicator: hasActivity },
    { id: "config", label: "Config" },
  ];
  return (
    <div className="kb-panel__tabs">
      {tabs.map(tab => (
        <button
          key={tab.id}
          className={cx("kb-panel__tab", activeTab === tab.id && "kb-panel__tab--active")}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.hasIndicator && <span className="kb-panel__tab-dot" />}
        </button>
      ))}
    </div>
  );
}

function InspectorMetricsBar({
  leaderStatus,
  leaderData,
}: {
  leaderStatus?: LeaderStatus;
  leaderData: LeaderData | null;
}) {
  const isRunning = leaderData?.status === "running";
  const worktreeActive = leaderData?.worktreeStatus === "active" || leaderData?.worktreeStatus === "creating";
  return (
    <div className="kb-panel__metrics">
      {/* Session status indicator */}
      <div className="kb-panel__metric">
        <span className={cx("kb-panel__metric-dot", isRunning ? "kb-panel__metric-dot--running" : leaderData?.status === "idle" ? "kb-panel__metric-dot--idle" : "kb-panel__metric-dot--off")} />
        <span className="kb-panel__metric-label">{leaderData?.status ?? "no session"}</span>
      </div>

      {leaderStatus && leaderStatus.turns > 0 && (
        <div className="kb-panel__metric">
          <span className="kb-panel__metric-icon">↻</span>
          <span className="kb-panel__metric-value">{leaderStatus.turns}</span>
          <span className="kb-panel__metric-label">turns</span>
        </div>
      )}

      {leaderStatus && leaderStatus.cost > 0 && (
        <div className="kb-panel__metric">
          <span className="kb-panel__metric-icon">$</span>
          <span className="kb-panel__metric-value">{leaderStatus.cost.toFixed(2)}</span>
        </div>
      )}

      {worktreeActive && (
        <div className="kb-panel__metric kb-panel__metric--worktree">
          <span className="kb-panel__metric-icon">⑂</span>
          <span className="kb-panel__metric-label">{leaderData?.worktreeBranch ?? "worktree"}</span>
        </div>
      )}
    </div>
  );
}

function TaskPlanSection({ taskPlan }: { taskPlan: TaskPlanItem[] }) {
  if (taskPlan.length === 0) return null;
  const doneCount = taskPlan.filter(t => t.status === "completed").length;
  const pct = Math.round((doneCount / taskPlan.length) * 100);
  return (
    <div className="kb-panel__section">
      <div className="kb-panel__label">
        Task Plan
        <span className="kb-panel__label-badge">{doneCount}/{taskPlan.length}</span>
      </div>
      <div className="kb-panel__plan-bar">
        <div className="kb-panel__plan-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="kb-panel__plan-list">
        {taskPlan.map(t => {
          const icon =
            t.status === "completed" ? "✓" :
            t.status === "running" ? "●" :
            t.status === "failed" ? "✗" : "○";
          const stateClass =
            t.status === "completed" ? "kb-panel__plan-item--done" :
            t.status === "running" ? "kb-panel__plan-item--running" :
            t.status === "failed" ? "kb-panel__plan-item--failed" : "";
          return (
            <div key={t.taskId} className={cx("kb-panel__plan-item", stateClass)}>
              <span className="kb-panel__plan-icon">{icon}</span>
              <span className="kb-panel__plan-title">{t.title}</span>
              {t.executor === "minion" && <span className="kb-panel__plan-executor">minion</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LiveChatView({
  messages,
  streamingText,
}: {
  messages: DisplayMessage[];
  streamingText: string;
}) {
  const chatRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);

  // Track if user is at bottom before re-render
  useEffect(() => {
    const el = chatRef.current;
    if (!el) return;
    const handler = () => {
      wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };
    el.addEventListener("scroll", handler, { passive: true });
    return () => el.removeEventListener("scroll", handler);
  }, []);

  // Auto-scroll on new messages if user was at bottom
  useEffect(() => {
    if (wasAtBottomRef.current && chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [messages.length, streamingText]);

  const visibleMessages = messages.filter(
    m => m.role === "user" || m.role === "assistant" || m.role === "system" || m.role === "result" || m.role === "tool"
  );

  return (
    <div ref={chatRef} className="kb-panel__livechat">
      {visibleMessages.length === 0 && !streamingText && (
        <div className="kb-panel__livechat-empty">No messages yet</div>
      )}
      {visibleMessages.map(msg => (
        <div key={msg.id} className={cx("kb-panel__chatmsg", `kb-panel__chatmsg--${msg.role}`)}>
          <div className="kb-panel__chatmsg-header">
            <span className="kb-panel__chatmsg-role">
              {msg.role === "user" ? "You" : msg.role === "assistant" ? "Agent" : msg.role === "tool" ? (msg.toolName ?? "Tool") : msg.role === "result" ? "Result" : "System"}
            </span>
            {msg.suffix && <span className="kb-panel__chatmsg-suffix">{msg.suffix}</span>}
          </div>
          <div className="kb-panel__chatmsg-body">
            {msg.role === "tool" && msg.toolName ? (
              <span className="kb-panel__chatmsg-tool">{msg.toolName}</span>
            ) : (
              msg.content
            )}
          </div>
        </div>
      ))}
      {streamingText && (
        <div className="kb-panel__chatmsg kb-panel__chatmsg--assistant kb-panel__chatmsg--streaming">
          <div className="kb-panel__chatmsg-header">
            <span className="kb-panel__chatmsg-role">Agent</span>
            <span className="kb-panel__chatmsg-streaming-dot" />
          </div>
          <div className="kb-panel__chatmsg-body">{streamingText}</div>
        </div>
      )}
    </div>
  );
}

function InspectorConfigSection({
  card,
  dispatch,
  editable,
}: {
  card: KanbanCard;
  dispatch: Dispatch<KanbanAction>;
  editable: boolean;
}) {
  const taggedSkills = (card.skillIds ?? [])
    .map(id => getSkill(id))
    .filter((s): s is SkillTemplate => s !== undefined);

  return (
    <div className="kb-panel__config-section">
      {/* Model */}
      <div className="kb-panel__config-group">
        <div className="kb-panel__config-label">Model</div>
        {editable ? (
          <div className="kb-panel__config-options">
            {(["sonnet", "opus", "haiku"] as ModelOption[]).map(m => (
              <button
                key={m}
                className={cx("kb-panel__config-opt", card.model === m && "kb-panel__config-opt--active")}
                onClick={() => dispatch({ type: "UPDATE_CARD", cardId: card.id, data: { model: m } })}
              >
                {MODEL_LABELS[m]}
              </button>
            ))}
          </div>
        ) : (
          <span className="kb-panel__config-value">{MODEL_LABELS[card.model ?? "sonnet"]}</span>
        )}
      </div>

      {/* Permission Mode */}
      <div className="kb-panel__config-group">
        <div className="kb-panel__config-label">Permissions</div>
        {editable ? (
          <div className="kb-panel__config-options">
            {(["auto", "bypassPermissions", "default", "plan", "acceptEdits"] as PermissionMode[]).map(pm => (
              <button
                key={pm}
                className={cx("kb-panel__config-opt", card.permissionMode === pm && "kb-panel__config-opt--active")}
                onClick={() => dispatch({ type: "UPDATE_CARD", cardId: card.id, data: { permissionMode: pm } })}
                title={PERMISSION_DESCRIPTIONS[pm]}
              >
                {PERMISSION_LABELS[pm]}
              </button>
            ))}
          </div>
        ) : (
          <span className="kb-panel__config-value">{PERMISSION_LABELS[card.permissionMode ?? "auto"]}</span>
        )}
      </div>

      {/* Worktree */}
      <div className="kb-panel__config-group">
        <div className="kb-panel__config-label">Git Worktree</div>
        {editable ? (
          <label className="kb-panel__config-toggle">
            <input
              type="checkbox"
              checked={card.worktreeIsolation}
              onChange={() => dispatch({ type: "UPDATE_CARD", cardId: card.id, data: { worktreeIsolation: !card.worktreeIsolation } })}
            />
            <span>{card.worktreeIsolation ? "Isolated" : "Shared"}</span>
          </label>
        ) : (
          <span className="kb-panel__config-value">{card.worktreeIsolation ? "Isolated" : "Shared"}</span>
        )}
      </div>

      {/* Skills */}
      {taggedSkills.length > 0 && (
        <div className="kb-panel__config-group">
          <div className="kb-panel__config-label">Skills</div>
          <div className="kb-panel__config-skills">
            {taggedSkills.map(skill => (
              <span key={skill.id} className="kb-panel__config-skill" style={{ borderColor: `color-mix(in srgb, ${skill.accentColor} 40%, transparent)` }}>
                <span>{skill.icon}</span>
                <span>{skill.name}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function KanbanInspectorPanel({
  selectedCard,
  leaderStatus,
  leaderMessages,
  leaderData,
  dispatch,
  onClose,
  onResume,
  onCloseCard,
  onLaunchLeader,
  onFocusNode,
  recentCards,
  onSelectCard,
  socketSend,
  onUpdateNodeData,
  inspectorOpen,
  contextNodes,
}: {
  selectedCard: KanbanCard | null;
  leaderStatus?: LeaderStatus;
  leaderMessages: DisplayMessage[];
  leaderData: LeaderData | null;
  dispatch: Dispatch<KanbanAction>;
  onClose: () => void;
  onResume: (card: KanbanCard) => void;
  onCloseCard: (card: KanbanCard) => void;
  onLaunchLeader: (card: KanbanCard) => void;
  onFocusNode?: (nodeId: string) => void;
  recentCards: KanbanCard[];
  onSelectCard: (cardId: string) => void;
  socketSend: (data: unknown) => void;
  onUpdateNodeData?: (nodeId: string, data: unknown) => void;
  inspectorOpen?: boolean;
  contextNodes?: ContextNodeOption[];
}) {
  const [activeTab, setActiveTab] = useState<InspectorTab>("activity");
  const [chatInput, setChatInput] = useState("");

  // Reset to activity tab when card changes
  const prevCardIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedCard?.id !== prevCardIdRef.current) {
      prevCardIdRef.current = selectedCard?.id ?? null;
      setChatInput("");
      if (selectedCard?.columnId === "backlog") {
        setActiveTab("config");
      } else {
        setActiveTab("activity");
      }
    }
  }, [selectedCard?.id, selectedCard?.columnId]);

  // Send a message to the leader session
  const handleChatSend = useCallback(() => {
    if (!chatInput.trim() || !selectedCard?.leaderNodeId || !leaderData?.sessionKey) return;

    // Compile skills into system prompt
    const taggedSkills = (leaderData.skillIds ?? [])
      .map((id) => getSkill(id))
      .filter((s): s is SkillTemplate => s !== undefined);
    const skillsAddendum = compileSkills(taggedSkills, leaderData.skillValues ?? {});
    const finalSystemPrompt = LEADER_SYSTEM_PROMPT + skillsAddendum;

    socketSend({
      type: "send_message",
      sessionKey: leaderData.sessionKey,
      prompt: chatInput.trim(),
      systemPrompt: finalSystemPrompt,
    });

    // Update the leader node data with the user message
    if (onUpdateNodeData) {
      onUpdateNodeData(selectedCard.leaderNodeId, {
        ...leaderData,
        status: "running",
        messages: [
          ...leaderData.messages,
          {
            id: msgId(),
            role: "user" as const,
            content: chatInput.trim(),
            timestamp: Date.now(),
          },
        ],
      });
    }
    setChatInput("");
  }, [chatInput, selectedCard, leaderData, socketSend, onUpdateNodeData]);

  const handleChatKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleChatSend();
    }
  }, [handleChatSend]);

  const handleStop = useCallback(() => {
    if (!leaderData?.sessionKey) return;
    socketSend({ type: "stop_session", sessionKey: leaderData.sessionKey });
  }, [leaderData?.sessionKey, socketSend]);

  if (!selectedCard) {
    return (
      <div className={cx("kb-panel", inspectorOpen && "kb-panel--open")}>
        <div className="kb-panel__header">
          <span className="kb-panel__title" style={{ flex: 1 }}>Inspector</span>
          <button className="kb-btn kb-btn--icon kb-panel__close-btn" onClick={onClose} aria-label="Close inspector">{"\u00D7"}</button>
        </div>
        <div className="kb-panel__empty">
          <div className="kb-panel__empty-icon">{"\u2B21"}</div>
          <div className="kb-panel__empty-text">Select a card to inspect</div>
          {recentCards.length > 0 && (
            <div className="kb-panel__recent">
              <div className="kb-panel__recent-label">Active agents</div>
              {recentCards.map(card => {
                const dotColor = card.columnId === "halted" ? "var(--status-warning)" : "var(--status-success)";
                return (
                  <div key={card.id} className="kb-panel__recent-row" onClick={() => onSelectCard(card.id)}>
                    <span className="kb-panel__recent-dot" style={{ background: dotColor }} />
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{card.title}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  const isEditable = selectedCard.columnId === "backlog";
  const hasActivity = leaderMessages.length > 0 || (leaderData?.streamingText ?? "").length > 0;
  const taskPlan = leaderData?.taskPlan ?? [];
  const hasSession = !!leaderData?.sessionKey;
  const isRunning = leaderData?.status === "running";

  return (
    <div className={cx("kb-panel", inspectorOpen && "kb-panel--open")}>
      {/* Header */}
      <div className="kb-panel__header">
        <span className="kb-panel__title" style={{ flex: 1 }}>
          {leaderData?.taskName ?? selectedCard.title}
        </span>
        <button className="kb-btn kb-btn--icon" onClick={onClose} aria-label="Close inspector">{"\u00D7"}</button>
      </div>

      {/* Status row */}
      <div className="kb-panel__status">
        <PriorityBadge priority={selectedCard.priority} />
        <ColumnBadge columnId={selectedCard.columnId} blockReason={selectedCard.blockReason} />
      </div>

      {/* Metrics bar — always visible when we have a leader */}
      {leaderData && (
        <InspectorMetricsBar leaderStatus={leaderStatus} leaderData={leaderData} />
      )}

      {/* Halt alert */}
      {selectedCard.columnId === "halted" && selectedCard.blockDetail && (
        <div className="kb-panel__alert-bar">
          <div className="kb-panel__alert">{selectedCard.blockDetail}</div>
        </div>
      )}

      {/* Tab bar */}
      <InspectorTabBar activeTab={activeTab} onChange={setActiveTab} hasActivity={hasActivity} />

      {/* Tab content — scrollable */}
      <div className="kb-panel__body">
        {activeTab === "activity" && (
          <>
            {/* Task plan progress */}
            <TaskPlanSection taskPlan={taskPlan} />

            {/* Live chat */}
            <div className="kb-panel__section kb-panel__section--flex">
              <LiveChatView messages={leaderMessages} streamingText={leaderData?.streamingText ?? ""} />
            </div>

            {/* Agent summary for history */}
            {selectedCard.agentSummary && (
              <div className="kb-panel__section">
                <div className="kb-panel__label">Summary</div>
                <div className="kb-panel__text">{selectedCard.agentSummary}</div>
              </div>
            )}
          </>
        )}

        {activeTab === "config" && (
          <>
            {isEditable ? (
              <CardForm
                key={selectedCard.id}
                initial={{
                  title: selectedCard.title,
                  description: selectedCard.description,
                  context: selectedCard.context,
                  priority: selectedCard.priority,
                  subtasks: selectedCard.subtasks,
                  model: selectedCard.model ?? "sonnet",
                  permissionMode: selectedCard.permissionMode ?? "auto",
                  worktreeIsolation: selectedCard.worktreeIsolation ?? true,
                  skillIds: selectedCard.skillIds ?? [],
                  skillValues: selectedCard.skillValues ?? {},
                  linkedContextNodeIds: selectedCard.linkedContextNodeIds ?? [],
                }}
                submitLabel="Save"
                onCancel={onClose}
                contextNodes={contextNodes}
                onSubmit={(data) => {
                  dispatch({
                    type: "UPDATE_CARD",
                    cardId: selectedCard.id,
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
                      linkedContextNodeIds: data.linkedContextNodeIds,
                    },
                  });
                }}
              />
            ) : (
              <>
                <InspectorConfigSection card={selectedCard} dispatch={dispatch} editable={false} />

                {/* Description */}
                {selectedCard.description && (
                  <div className="kb-panel__section">
                    <div className="kb-panel__label">Description</div>
                    <div className="kb-panel__text">{selectedCard.description}</div>
                  </div>
                )}

                {/* Context */}
                {selectedCard.context && (
                  <div className="kb-panel__section">
                    <div className="kb-panel__label">Context</div>
                    <div className="kb-panel__text kb-panel__text--mono">{selectedCard.context}</div>
                  </div>
                )}

                {/* Linked context nodes */}
                {(selectedCard.linkedContextNodeIds ?? []).length > 0 && (
                  <div className="kb-panel__section">
                    <div className="kb-panel__label">Linked Context ({(selectedCard.linkedContextNodeIds ?? []).length})</div>
                    <div className="kb-card__linked-context">
                      {(selectedCard.linkedContextNodeIds ?? []).map((nid) => (
                        <span key={nid} className="kb-linked-context-tag">{"\uD83D\uDCCE"} {nid.slice(0, 8)}</span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Subtasks */}
                {selectedCard.subtasks.length > 0 && (
                  <div className="kb-panel__section">
                    <div className="kb-panel__label">Subtasks ({selectedCard.subtasks.filter(s => s.done).length}/{selectedCard.subtasks.length})</div>
                    {selectedCard.subtasks.map(st => (
                      <label key={st.id} className={cx("kb-panel__subtask", st.done && "kb-panel__subtask--done")}>
                        <input type="checkbox" checked={st.done}
                          onChange={() => dispatch({ type: "TOGGLE_SUBTASK", cardId: selectedCard.id, subtaskId: st.id })} />
                        {st.title}
                      </label>
                    ))}
                  </div>
                )}

                <div className="kb-panel__meta">Created {new Date(selectedCard.createdAt).toLocaleDateString()}</div>
              </>
            )}
          </>
        )}
      </div>

      {/* Chat input — shown on activity tab when there's an active session */}
      {activeTab === "activity" && hasSession && (
        <div className="kb-panel__input-bar">
          {isRunning ? (
            <button className="kb-btn kb-btn--danger-ghost kb-btn--sm" onClick={handleStop}>
              <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
                <rect width="8" height="8" rx="1" fill="currentColor" />
              </svg>
              Stop
            </button>
          ) : (
            <>
              <textarea
                className="kb-panel__input"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={handleChatKeyDown}
                placeholder="Send a message..."
                rows={1}
              />
              <button
                className="kb-btn kb-btn--primary kb-btn--sm"
                onClick={handleChatSend}
                disabled={!chatInput.trim()}
              >
                Send
              </button>
            </>
          )}
        </div>
      )}

      {/* Footer actions */}
      <div className="kb-panel__footer">
        {selectedCard.columnId === "backlog" && (
          <button className="kb-btn kb-btn--primary" onClick={() => onLaunchLeader(selectedCard)}>Launch</button>
        )}
        {selectedCard.columnId === "in-progress" && (
          <button className="kb-btn kb-btn--ghost" onClick={() => onCloseCard(selectedCard)}>Complete</button>
        )}
        {selectedCard.columnId === "halted" && selectedCard.blockReason !== "idle_review" && (
          <>
            <button className="kb-btn kb-btn--primary" onClick={() => onResume(selectedCard)}>Resume</button>
            <button className="kb-btn kb-btn--ghost" onClick={() => onCloseCard(selectedCard)}>Close Card</button>
          </>
        )}
        {selectedCard.columnId === "halted" && selectedCard.blockReason === "idle_review" && (
          <button className="kb-btn kb-btn--success" onClick={() => onCloseCard(selectedCard)}>Approve & Close</button>
        )}
        {selectedCard.columnId === "history" && (
          <button className="kb-btn kb-btn--primary" onClick={() => onLaunchLeader(selectedCard)}>Attach to Canvas</button>
        )}
        {selectedCard.leaderNodeId && onFocusNode && selectedCard.columnId !== "history" && (
          <button className="kb-btn kb-btn--ghost" onClick={() => onFocusNode(selectedCard.leaderNodeId!)}>View on Canvas</button>
        )}
      </div>
    </div>
  );
}

// ─── Main Board Component ─────────────────────────────────

interface KanbanBoardProps {
  board: KanbanBoardType;
  dispatch: Dispatch<KanbanAction>;
  onLaunchLeader: (card: KanbanCard) => void;
  leaderStatuses: Map<string, LeaderStatus>;
  onCloseCard: (card: KanbanCard) => void;
  onResume: (card: KanbanCard) => void;
  onFocusNode?: (nodeId: string) => void;
  socketSend: (data: unknown) => void;
  socketSubscribe: (fn: (msg: ServerMessage) => void) => () => void;
  projectPath: string;
  nodes: CanvasNode[];
  onUpdateNodeData?: (nodeId: string, data: unknown) => void;
  projectSettings?: ProjectSettings;
}

export function KanbanBoard({
  board,
  dispatch,
  onLaunchLeader,
  leaderStatuses,
  onCloseCard,
  onResume,
  onFocusNode,
  socketSend,
  socketSubscribe,
  projectPath,
  nodes,
  onUpdateNodeData,
  projectSettings,
}: KanbanBoardProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [confirmClearDone, setConfirmClearDone] = useState(false);
  const [mobileColumnId, setMobileColumnId] = useState("backlog");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const addPopupRef = useRef<HTMLDivElement>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);

  // Open inspector overlay when a card is selected (for tablet/mobile)
  useEffect(() => {
    if (selectedCardId) setInspectorOpen(true);
  }, [selectedCardId]);

  const doneCount = board.cards.filter((c) => c.columnId === "history").length;
  const totalCards = board.cards.filter((c) => c.columnId !== "history").length;

  // Build available context nodes from canvas (markdown + file-viewer nodes)
  const availableContextNodes = useMemo<ContextNodeOption[]>(() => {
    return nodes
      .filter((n) => n.type === "markdown" || n.type === "file-viewer")
      .map((n) => {
        let label = n.id;
        if (n.type === "markdown") {
          const d = n.data as { title?: string };
          label = d.title || "Untitled Markdown";
        } else if (n.type === "file-viewer") {
          const d = n.data as { filePath?: string };
          label = d.filePath || "No file selected";
        }
        return { id: n.id, type: n.type, label };
      });
  }, [nodes]);

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
        linkedContextNodeIds: data.linkedContextNodeIds,
        columnId: "backlog",
        createdAt: Date.now(),
      };
      dispatch({ type: "ADD_CARD", card });
      setShowAddForm(false);
      addBtnRef.current?.focus();
    },
    [dispatch],
  );

  // Column summary chips — exclude archive (shown in toolbar toggle)
  const columnSummary = board.columns
    .map((col) => ({
      id: col.id,
      title: col.title,
      color: col.color,
      count: board.cards.filter((c) => c.columnId === col.id).length,
    }));

  // Visible columns — archive is hidden unless toggled on
  const visibleColumns = board.columns;

  // Leader data for the selected card's agent
  // Falls back to archived data when the live leader node no longer exists (history cards)
  const selectedLeaderData = useMemo((): LeaderData | null => {
    if (!selectedCardId) return null;
    const card = board.cards.find(c => c.id === selectedCardId);
    if (!card) return null;

    // Try live leader node first
    if (card.leaderNodeId) {
      const node = nodes.find(n => n.id === card.leaderNodeId);
      if (node) return node.data as LeaderData;
    }

    // Fall back to archived data for history cards
    if (card.archivedMessages || card.archivedTaskPlan) {
      return {
        sessionKey: null,
        status: "stopped",
        messages: card.archivedMessages ?? [],
        streamingText: "",
        totalCost: card.agentCost ?? 0,
        turns: card.archivedTurns ?? 0,
        error: null,
        model: card.model,
        permissionMode: card.permissionMode,
        taskPlan: card.archivedTaskPlan ?? [],
        worktreeIsolation: card.worktreeIsolation,
        worktreePath: null,
        worktreeBranch: null,
        worktreeStatus: "none",
        skillIds: card.skillIds,
        skillValues: card.skillValues,
        skillPanelOpen: false,
        taskName: card.archivedTaskName,
      } satisfies LeaderData;
    }

    return null;
  }, [selectedCardId, board.cards, nodes]);

  const leaderMessages = useMemo((): DisplayMessage[] => {
    return selectedLeaderData?.messages ?? [];
  }, [selectedLeaderData]);

  // Recent cards for inspector empty state — only show cards with a live leader session
  const recentCards = useMemo(() =>
    board.cards
      .filter(c =>
        (c.columnId === "halted" || c.columnId === "in-progress") &&
        c.leaderNodeId != null &&
        leaderStatuses.has(c.leaderNodeId),
      )
      .sort((a, b) => (a.columnId === "halted" ? -1 : 1) - (b.columnId === "halted" ? -1 : 1)),
    [board.cards, leaderStatuses]
  );

  // Compute selected card's leader status
  const selectedCard = board.cards.find(c => c.id === selectedCardId) ?? null;
  const selectedLeaderStatus = selectedCard?.leaderNodeId
    ? leaderStatuses.get(selectedCard.leaderNodeId)
    : undefined;

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
        <div className="kb-toolbar__right">
          <button
            className="kb-btn kb-btn--ghost kb-toolbar__mobile-inspector-btn"
            onClick={() => setInspectorOpen((v) => !v)}
            aria-label="Toggle inspector panel"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="1" y="1" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
              <line x1="10" y1="1" x2="10" y2="15" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>
      </div>

      {/* Mobile column tab bar */}
      <nav className="kb-column-tabs" role="tablist" aria-label="Board columns">
        {visibleColumns.map((col) => {
          const count = board.cards.filter((c) => c.columnId === col.id).length;
          return (
            <button
              key={col.id}
              role="tab"
              aria-selected={mobileColumnId === col.id}
              className={cx("kb-column-tab", mobileColumnId === col.id && "kb-column-tab--active")}
              onClick={() => setMobileColumnId(col.id)}
            >
              <span className="kb-column-tab__dot" style={{ background: col.color }} />
              {col.title}
              <span className="kb-column-tab__count">{count}</span>
            </button>
          );
        })}
      </nav>

      {/* Two-pane layout */}
      <div className="kb-layout">
        {/* Left: columns + optional chat */}
        <div className="kb-columns-area">
          <div className="kb-columns">
            {visibleColumns.map((col) => {
              const columnCards = board.cards.filter((c) => c.columnId === col.id);
              const isBacklog = col.id === "backlog";
              const isDone = col.id === "history";
              return (
                <KanbanColumnComponent
                  key={col.id}
                  column={col}
                  cards={columnCards}
                  dispatch={dispatch}
                  onLaunchLeader={onLaunchLeader}
                  onCloseCard={onCloseCard}
                  onResume={onResume}
                  leaderStatuses={leaderStatuses}
                  onFocusNode={onFocusNode}
                  selectedCardId={selectedCardId}
                  onSelectCard={setSelectedCardId}
                  extraClassName={mobileColumnId === col.id ? "kb-column--mobile-active" : undefined}
                  contextNodes={availableContextNodes}
                  headerActions={isDone && doneCount > 0 ? (
                    <div className="kb-column__actions">
                      <button
                        className="kb-btn kb-btn--sm kb-btn--danger-ghost"
                        onClick={() => setConfirmClearArchive(true)}
                      >
                        Clear
                      </button>
                    </div>
                  ) : isBacklog ? (
                    <div className="kb-column__actions">
                      <button
                        className={cx("kb-btn kb-btn--sm", showChat ? "kb-btn--ghost" : "kb-btn--secondary", "kb-toolbar__chat-btn")}
                        onClick={() => { setShowChat((v) => !v); if (showAddForm) setShowAddForm(false); }}
                        aria-expanded={showChat}
                        aria-haspopup="dialog"
                        aria-label={showChat ? "Close AI chat" : "AI Create card"}
                      >
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <path
                            d="M2 2.5A2.5 2.5 0 014.5 0h7A2.5 2.5 0 0114 2.5v8a2.5 2.5 0 01-2.5 2.5H6l-3 3v-3H2.5A2.5 2.5 0 010 10.5v-8z"
                            fill="currentColor"
                          />
                        </svg>
                        <span className="kb-btn__label">{showChat ? "Close" : "AI Create"}</span>
                      </button>
                      <button
                        ref={addBtnRef}
                        className={cx("kb-btn kb-btn--sm", showAddForm ? "kb-btn--ghost" : "kb-btn--primary")}
                        onClick={() => setShowAddForm((v) => !v)}
                        aria-expanded={showAddForm}
                        aria-haspopup="dialog"
                        aria-label={showAddForm ? "Cancel adding card" : "Add new card"}
                      >
                        <span className="kb-btn__icon" aria-hidden="true">{showAddForm ? "\u00D7" : "+"}</span>
                        <span className="kb-btn__label">{showAddForm ? "Cancel" : "Add"}</span>
                      </button>
                    </div>
                  ) : undefined}
                  belowHeader={isBacklog && showAddForm ? (
                    <div ref={addPopupRef} className="kb-backlog-add-form" role="dialog" aria-label="Add card" aria-modal="false">
                      <CardForm
                        submitLabel="Add Card"
                        onSubmit={handleAddCard}
                        onCancel={() => { setShowAddForm(false); addBtnRef.current?.focus(); }}
                        contextNodes={availableContextNodes}
                        defaultWorktreeIsolation={projectSettings?.defaultWorktreeIsolation}
                      />
                    </div>
                  ) : undefined}
                />
              );
            })}
          </div>
          {showChat && (
            <CardCreationChat
              dispatch={dispatch}
              socketSend={socketSend}
              socketSubscribe={socketSubscribe}
              onClose={() => setShowChat(false)}
              projectPath={projectPath}
              defaultWorktreeIsolation={projectSettings?.defaultWorktreeIsolation}
            />
          )}
        </div>

        {/* Right: persistent inspector (with overlay backdrop for tablet/mobile) */}
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
        <div
          className={cx("kb-panel-backdrop", inspectorOpen && "kb-panel-backdrop--visible")}
          onClick={() => { setInspectorOpen(false); setSelectedCardId(null); }}
        />
        <KanbanInspectorPanel
          selectedCard={selectedCard}
          leaderStatus={selectedLeaderStatus}
          leaderMessages={leaderMessages}
          leaderData={selectedLeaderData}
          dispatch={dispatch}
          onClose={() => { setSelectedCardId(null); setInspectorOpen(false); }}
          onResume={onResume}
          onCloseCard={onCloseCard}
          onLaunchLeader={onLaunchLeader}
          onFocusNode={onFocusNode}
          recentCards={recentCards}
          onSelectCard={(cardId) => { setSelectedCardId(cardId); setInspectorOpen(true); }}
          socketSend={socketSend}
          onUpdateNodeData={onUpdateNodeData}
          inspectorOpen={inspectorOpen}
          contextNodes={availableContextNodes}
        />
      </div>

      {confirmClearDone && (
        <DeleteConfirm
          cardTitle={`all ${doneCount} history card${doneCount !== 1 ? "s" : ""}`}
          onConfirm={() => { dispatch({ type: "CLEAR_ARCHIVE" }); setConfirmClearArchive(false); }}
          onCancel={() => setConfirmClearArchive(false)}
        />
      )}
    </div>
  );
}
