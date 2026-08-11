import { useRef, useState, type ChangeEvent } from "react";
import type { SkillAttachment } from "./skills/types.ts";
import {
  fileToTextAttachment,
  TEXT_ATTACHMENT_ACCEPT,
} from "./mobile/attachments.ts";
import { MAX_SKILL_ATTACHMENTS } from "../shared/skill-attachments.ts";

interface SkillAttachmentEditorProps {
  attachments: SkillAttachment[];
  onChange: (attachments: SkillAttachment[]) => void;
  label?: string;
  inputLabel?: string;
}

export function SkillAttachmentEditor({
  attachments,
  onChange,
  label = "Attached context",
  inputLabel = "Skill context files",
}: SkillAttachmentEditorProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  async function attach(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length === 0) return;
    const available = Math.max(0, MAX_SKILL_ATTACHMENTS - attachments.length);
    if (available === 0) {
      setError(`A maximum of ${MAX_SKILL_ATTACHMENTS} context files can be attached.`);
      return;
    }
    const results = await Promise.allSettled(
      files.slice(0, available).map((file) => fileToTextAttachment(file)),
    );
    const added = results
      .filter((result): result is PromiseFulfilledResult<SkillAttachment> => result.status === "fulfilled")
      .map((result) => result.value);
    const failures = results.filter((result) => result.status === "rejected").length;
    if (added.length > 0) onChange([...attachments, ...added]);
    const omitted = failures + Math.max(0, files.length - available);
    setError(omitted > 0
      ? `${omitted} file(s) could not be attached. Use a supported text, code, or data file.`
      : null);
  }

  return (
    <section aria-label={label} style={{ marginTop: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div>
          <strong style={{ display: "block", fontSize: 12, color: "var(--text-secondary)" }}>{label}</strong>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            Text, Markdown, source, and structured-data files are frozen into the agent context.
          </span>
        </div>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid var(--border-default)",
            background: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 12 }}
        >
          Attach files
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={TEXT_ATTACHMENT_ACCEPT}
        multiple
        aria-label={inputLabel}
        onChange={(event) => void attach(event)}
        style={{ display: "none" }}
      />
      {attachments.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {attachments.map((attachment, index) => (
            <span key={`${attachment.filename}-${index}`} style={{ display: "inline-flex", alignItems: "center",
              gap: 6, padding: "4px 7px", border: "1px solid var(--border-default)", borderRadius: 6,
              fontSize: 11, color: "var(--text-secondary)", background: "var(--bg-elevated)" }}>
              {attachment.filename}{attachment.truncated ? " (truncated)" : ""}
              <button
                type="button"
                aria-label={`Remove ${attachment.filename}`}
                onClick={() => onChange(attachments.filter((_, itemIndex) => itemIndex !== index))}
                style={{ border: 0, background: "none", color: "var(--text-muted)", cursor: "pointer", padding: 0 }}
              >×</button>
            </span>
          ))}
        </div>
      ) : null}
      {error ? <div role="alert" style={{ marginTop: 6, color: "var(--danger-color)", fontSize: 11 }}>{error}</div> : null}
    </section>
  );
}
