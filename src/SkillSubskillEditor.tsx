/**
 * Sub-skill authoring UI — a controlled list editor embedded in SkillEditor.
 *
 * A skill can carry nested sub-skills (one level). Each sub-skill's `id` is
 * auto-derived from its name (mirroring the parent skill's id generation).
 * Bodies are pulled on demand at runtime via the `load_subskill` tool unless
 * `alwaysInclude` eager-inlines them.
 */

import { useCallback } from "react";
import type { SubSkill } from "./skills/types.ts";
import { SkillAttachmentEditor } from "./SkillAttachmentEditor.tsx";

/** Slugify a name into a stable-ish id (mirrors SkillEditor.generateId). */
export function generateSubskillId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function emptySubskill(): SubSkill {
  return { id: "", name: "", description: "", body: "" };
}

interface SkillSubskillEditorProps {
  subskills: SubSkill[];
  onChange: (subskills: SubSkill[]) => void;
}

const fieldLabel: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  color: "var(--text-secondary)",
  marginBottom: 3,
  fontFamily: "var(--font-sans)",
};

const fieldInput: React.CSSProperties = {
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

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--border-default)",
  borderRadius: 6,
  padding: 12,
  marginBottom: 10,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  background: "var(--bg-primary)",
};

export function SkillSubskillEditor({
  subskills,
  onChange,
}: SkillSubskillEditorProps) {
  const update = useCallback(
    (idx: number, patch: Partial<SubSkill>) => {
      const next = subskills.map((s, i) => {
        if (i !== idx) return s;
        const merged = { ...s, ...patch };
        // Keep the id in sync with the name (auto-derived).
        if (patch.name !== undefined) merged.id = generateSubskillId(patch.name);
        return merged;
      });
      onChange(next);
    },
    [subskills, onChange],
  );

  const remove = useCallback(
    (idx: number) => {
      onChange(subskills.filter((_, i) => i !== idx));
    },
    [subskills, onChange],
  );

  const add = useCallback(() => {
    onChange([...subskills, emptySubskill()]);
  }, [subskills, onChange]);

  return (
    <div>
      {subskills.map((sub, idx) => (
        <div key={idx} style={cardStyle}>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label style={fieldLabel}>Name</label>
              <input
                style={fieldInput}
                value={sub.name}
                placeholder="e.g. Layout rules"
                aria-label={`Sub-skill ${idx + 1} name`}
                onChange={(e) => update(idx, { name: e.target.value })}
              />
            </div>
            <div style={{ width: 160 }}>
              <label style={fieldLabel}>ID (auto)</label>
              <input
                style={{ ...fieldInput, color: "var(--text-secondary)" }}
                value={sub.id}
                readOnly
                tabIndex={-1}
                aria-label={`Sub-skill ${idx + 1} id`}
              />
            </div>
          </div>

          <div>
            <label style={fieldLabel}>Description (shown in the map)</label>
            <input
              style={fieldInput}
              value={sub.description}
              placeholder="One line summarizing what this sub-skill covers"
              aria-label={`Sub-skill ${idx + 1} description`}
              onChange={(e) => update(idx, { description: e.target.value })}
            />
          </div>

          <div>
            <label style={fieldLabel}>When to use (optional)</label>
            <input
              style={fieldInput}
              value={sub.whenToUse ?? ""}
              placeholder="Trigger hint, e.g. when arranging pages"
              aria-label={`Sub-skill ${idx + 1} when to use`}
              onChange={(e) => update(idx, { whenToUse: e.target.value })}
            />
          </div>

          <div>
            <label style={fieldLabel}>Body (pulled on demand)</label>
            <textarea
              style={{ ...fieldInput, minHeight: 90, resize: "vertical" }}
              value={sub.body}
              placeholder="Full sub-skill content, loaded via load_subskill"
              aria-label={`Sub-skill ${idx + 1} body`}
              onChange={(e) => update(idx, { body: e.target.value })}
            />
          </div>

          <SkillAttachmentEditor
            attachments={sub.attachments ?? []}
            onChange={(attachments) => update(idx, { attachments })}
            label="Sub-skill context"
            inputLabel={`Sub-skill ${idx + 1} context files`}
          />

          <div
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
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
                checked={sub.alwaysInclude ?? false}
                aria-label={`Sub-skill ${idx + 1} always include`}
                onChange={(e) => update(idx, { alwaysInclude: e.target.checked })}
              />
              Always include (eager-inline body)
            </label>
            <button
              type="button"
              onClick={() => remove(idx)}
              style={{
                padding: "4px 10px",
                borderRadius: 6,
                border: "1px solid var(--border-default)",
                background: "none",
                color: "var(--text-secondary)",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              Remove
            </button>
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={add}
        style={{
          padding: "6px 12px",
          borderRadius: 6,
          border: "1px solid var(--border-default)",
          background: "none",
          color: "var(--text-secondary)",
          cursor: "pointer",
          fontSize: 12,
        }}
      >
        + Add sub-skill
      </button>
    </div>
  );
}
