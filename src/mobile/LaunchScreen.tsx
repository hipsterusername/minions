import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";

import { listProjects, type ProjectSummary } from "../api.ts";
import { randomUuid } from "../random-id.ts";
import { useHarnessList } from "../use-harness-list.tsx";
import {
  TEXT_ATTACHMENT_ACCEPT,
  appendTextAttachmentsToPrompt,
  fileToImageAttachment,
  fileToTextAttachment,
  isAcceptedImageType,
  isAcceptedTextFile,
  type ImageAttachment,
  type TextAttachment,
} from "./attachments.ts";
import { buildLaunchModelGroups, parseLaunchModelValue } from "./launch-models.ts";

interface LaunchScreenProps {
  send: (data: unknown) => void;
  onLaunched: (sessionKey: string) => void;
  /**
   * When provided, the launch screen is locked to a single project: the
   * project picker is hidden and no project list is fetched. Used when the
   * mobile app is already scoped to a selected project.
   */
  lockedProject?: { path: string; name: string };
}

export function LaunchScreen({ send, onLaunched, lockedProject }: LaunchScreenProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  // Encoded `harness::modelId` from the dropdown; "" = the harness default.
  const [modelValue, setModelValue] = useState("");
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([]);
  const [textAttachments, setTextAttachments] = useState<TextAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [worktreeIsolation, setWorktreeIsolation] = useState(false);
  const [loading, setLoading] = useState(!lockedProject);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Enumerated models for the launch dropdown, across every registered harness
  // (Anthropic, OpenAI, …) so all providers are selectable. Empty until
  // `list_harnesses` answers — the "Default" option always works meanwhile.
  const { harnesses } = useHarnessList();
  const modelGroups = buildLaunchModelGroups(harnesses);

  useEffect(() => {
    if (lockedProject) return;

    let cancelled = false;

    setLoading(true);
    setError(null);
    void listProjects()
      .then((result) => {
        if (cancelled) return;
        setProjects(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load projects");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [lockedProject]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const targetPath = lockedProject?.path ?? selectedProject?.path ?? null;
  const targetName = lockedProject?.name ?? selectedProject?.name ?? null;
  const trimmedPrompt = prompt.trim();
  const attachedFileCount = imageAttachments.length + textAttachments.length;
  const canSubmit = targetPath !== null && (trimmedPrompt.length > 0 || attachedFileCount > 0);
  const selectedModel = parseLaunchModelValue(modelValue);
  const modelLabel = selectedModel?.model ?? "Default";

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!targetPath || (!trimmedPrompt && attachedFileCount === 0)) return;

    const sessionKey = `leader-${randomUuid()}`;
    send({
      type: "create_session",
      sessionKey,
      prompt: appendTextAttachmentsToPrompt(trimmedPrompt, textAttachments),
      role: "leader",
      cwd: targetPath,
      worktreeIsolation,
      ...(imageAttachments.length > 0 ? { attachments: imageAttachments } : {}),
      // Empty value = let the server/harness pick its default model. A chosen
      // model carries its harness so cross-provider models (e.g. OpenAI) resolve.
      ...(selectedModel ? { model: selectedModel.model, harness: selectedModel.harness } : {}),
    });
    onLaunched(sessionKey);
  }

  async function handleAttachChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length === 0) return;

    const imageFiles = files.filter((file) => isAcceptedImageType(file.type));
    const textFiles = files.filter((file) => !isAcceptedImageType(file.type) && isAcceptedTextFile(file));
    const rejectedCount = files.length - imageFiles.length - textFiles.length;
    const [imageSettled, textSettled] = await Promise.all([
      Promise.allSettled(imageFiles.map((file) => fileToImageAttachment(file))),
      Promise.allSettled(textFiles.map((file) => fileToTextAttachment(file))),
    ]);
    const acceptedImages = imageSettled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const acceptedText = textSettled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const failedCount =
      rejectedCount
      + imageSettled.filter((result) => result.status === "rejected").length
      + textSettled.filter((result) => result.status === "rejected").length;

    if (acceptedImages.length > 0) {
      setImageAttachments((current) => [...current, ...acceptedImages]);
    }
    if (acceptedText.length > 0) {
      setTextAttachments((current) => [...current, ...acceptedText]);
    }
    setAttachmentError(
      failedCount > 0
        ? "Some files were not supported. Use images or text files such as TXT, Markdown, HTML, JSON, CSV, or code."
        : null,
    );
  }

  function removeImageAttachment(index: number) {
    setImageAttachments((current) => current.filter((_, i) => i !== index));
  }

  function removeTextAttachment(index: number) {
    setTextAttachments((current) => current.filter((_, i) => i !== index));
  }

  return (
    <main className="mob-screen mob-launch" aria-label="Launch">
      <header className="mob-screen-header">
        <h1>Launch</h1>
      </header>

      {loading ? <div className="mob-launch-status">Loading projects...</div> : null}
      {error ? <div className="mob-launch-error" role="alert">{error}</div> : null}

      <form className="mob-launch-form" onSubmit={handleSubmit}>
        {lockedProject ? (
          <div className="mob-launch-project" aria-label="Project">
            <span>Project</span>
            <strong>{lockedProject.name}</strong>
            <small>{lockedProject.path}</small>
          </div>
        ) : (
          <fieldset className="mob-project-picker" disabled={loading}>
            <legend>Recent projects</legend>
            {projects.length === 0 && !loading ? (
              <p className="mob-muted">No recent projects found.</p>
            ) : null}
            {projects.map((project) => (
              <label className="mob-project-row" key={project.id}>
                <input
                  type="radio"
                  name="launch-project"
                  value={project.id}
                  checked={selectedProjectId === project.id}
                  onChange={() => setSelectedProjectId(project.id)}
                />
                <span>
                  <strong>{project.name}</strong>
                  <small>{project.path}</small>
                </span>
              </label>
            ))}
          </fieldset>
        )}

        <label className="mob-launch-field">
          <span>
            Prompt
            <small>{trimmedPrompt.length} chars</small>
          </span>
          <div className="mob-launch-templates" aria-label="Prompt starters">
            <button
              type="button"
              onClick={() => setPrompt("Review the recent changes, identify risks, and suggest the next safest action.")}
            >
              Review
            </button>
            <button
              type="button"
              onClick={() => setPrompt("Investigate the failing workflow, isolate the cause, and make the smallest reliable fix.")}
            >
              Fix
            </button>
            <button
              type="button"
              onClick={() => setPrompt("Implement the requested feature end to end, including focused verification.")}
            >
              Build
            </button>
          </div>
          <textarea
            aria-label="Prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            rows={7}
            placeholder="What should the leader do?"
          />
        </label>

        <section className="mob-launch-files" aria-label="Launch attachments">
          <div className="mob-launch-files-head">
            <span>Files</span>
            <button
              className="mob-launch-file-button"
              type="button"
              onClick={() => fileInputRef.current?.click()}
            >
              Attach
            </button>
          </div>
          <input
            ref={fileInputRef}
            className="mob-file-input"
            type="file"
            accept={`image/*,${TEXT_ATTACHMENT_ACCEPT}`}
            multiple
            onChange={handleAttachChange}
            aria-label="Launch file attachments"
          />
          {attachedFileCount > 0 ? (
            <div className="mob-composer-attachments" aria-label="Attached launch files">
              {imageAttachments.map((attachment, index) => (
                <span className="mob-attachment-chip mob-attachment-chip--image" key={`${attachment.filename ?? "image"}-${index}`}>
                  <img
                    src={`data:${attachment.mediaType};base64,${attachment.data}`}
                    alt={attachment.filename ?? `Attachment ${index + 1}`}
                  />
                  <button
                    type="button"
                    onClick={() => removeImageAttachment(index)}
                    aria-label={`Remove ${attachment.filename ?? `attachment ${index + 1}`}`}
                  >
                    ×
                  </button>
                </span>
              ))}
              {textAttachments.map((attachment, index) => (
                <span className="mob-attachment-chip mob-attachment-chip--text" key={`${attachment.filename}-${index}`}>
                  <span className="mob-attachment-file-icon" aria-hidden="true">TXT</span>
                  <span className="mob-attachment-file-name">{attachment.filename}</span>
                  <button
                    type="button"
                    onClick={() => removeTextAttachment(index)}
                    aria-label={`Remove ${attachment.filename}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="mob-muted">Attach images or text files.</p>
          )}
          {attachmentError ? <div className="mob-launch-error" role="alert">{attachmentError}</div> : null}
        </section>

        <label className="mob-launch-checkbox">
          <input
            type="checkbox"
            checked={worktreeIsolation}
            onChange={(event) => setWorktreeIsolation(event.currentTarget.checked)}
          />
          <span>Worktree isolation</span>
        </label>

        <label className="mob-launch-field">
          <span>Model</span>
          <select
            value={modelValue}
            onChange={(event) => setModelValue(event.currentTarget.value)}
          >
            <option value="">Default</option>
            {modelGroups.map((group) => (
              <optgroup key={group.harness} label={group.label}>
                {group.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <section className="mob-launch-review" aria-label="Launch summary">
          <div>
            <span>Target</span>
            <strong>{targetName ? "Selected project" : "Choose a project"}</strong>
          </div>
          <div>
            <span>Model</span>
            <strong>{modelLabel}</strong>
          </div>
          <div>
            <span>Isolation</span>
            <strong>{worktreeIsolation ? "Worktree" : "Current tree"}</strong>
          </div>
          <div>
            <span>Files</span>
            <strong>{attachedFileCount > 0 ? `${attachedFileCount} attached` : "None"}</strong>
          </div>
        </section>

        <button className="mob-launch-submit" type="submit" disabled={!canSubmit}>
          Launch leader
        </button>
      </form>
    </main>
  );
}
