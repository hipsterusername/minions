/** Frozen text context attached to a skill or sub-skill. */
export interface SkillAttachment {
  kind: "text";
  filename: string;
  mediaType: string;
  text: string;
  truncated: boolean;
}

export const MAX_SKILL_ATTACHMENT_CHARS = 200_000;
export const MAX_SKILL_ATTACHMENTS = 16;

const TEXT_EXTENSIONS = new Set([
  "c", "cc", "conf", "cpp", "cs", "css", "csv", "env", "go", "h", "hpp",
  "htm", "html", "java", "js", "json", "jsx", "log", "markdown", "md", "mdx",
  "mjs", "py", "rb", "rs", "sh", "sql", "toml", "ts", "tsx", "txt", "xml",
  "yaml", "yml",
]);

const TEXT_MEDIA_TYPES = new Set([
  "application/javascript",
  "application/json",
  "application/ld+json",
  "application/sql",
  "application/typescript",
  "application/x-javascript",
  "application/x-sh",
  "application/xhtml+xml",
  "application/xml",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

function singleLine(value: string, maxLength = 200): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, maxLength);
}

export function isSupportedSkillAttachment(
  filename: string,
  mediaType: string,
): boolean {
  return mediaType.startsWith("text/") || TEXT_MEDIA_TYPES.has(mediaType)
    || TEXT_EXTENSIONS.has(extensionOf(filename));
}

export interface SkillAttachmentInspection {
  attachments: SkillAttachment[];
  skipped: number;
  truncated: number;
}

/** Validate untrusted persisted/imported attachment data without throwing. */
export function inspectSkillAttachments(raw: unknown): SkillAttachmentInspection {
  if (!Array.isArray(raw)) {
    return { attachments: [], skipped: raw == null ? 0 : 1, truncated: 0 };
  }
  const attachments: SkillAttachment[] = [];
  let skipped = Math.max(0, raw.length - MAX_SKILL_ATTACHMENTS);
  let truncated = 0;
  for (const item of raw.slice(0, MAX_SKILL_ATTACHMENTS)) {
    if (!isRecord(item) || item["kind"] !== "text"
      || typeof item["filename"] !== "string" || !item["filename"].trim()
      || typeof item["text"] !== "string") {
      skipped += 1;
      continue;
    }
    const filename = singleLine(item["filename"]);
    const mediaType = typeof item["mediaType"] === "string" && item["mediaType"].trim()
      ? singleLine(item["mediaType"], 100).toLowerCase()
      : "text/plain";
    if (!filename || !isSupportedSkillAttachment(filename, mediaType)) {
      skipped += 1;
      continue;
    }
    const wasTruncated = item["text"].length > MAX_SKILL_ATTACHMENT_CHARS
      || item["truncated"] === true;
    if (wasTruncated) truncated += 1;
    attachments.push({
      kind: "text",
      filename,
      mediaType,
      text: item["text"].slice(0, MAX_SKILL_ATTACHMENT_CHARS),
      truncated: wasTruncated,
    });
  }
  return { attachments, skipped, truncated };
}

export function sanitizeSkillAttachments(raw: unknown): SkillAttachment[] {
  return inspectSkillAttachments(raw).attachments;
}

function fenceFor(text: string): string {
  let fence = "```";
  while (text.includes(fence)) fence += "`";
  return fence;
}

function languageFor(filename: string): string {
  const extension = extensionOf(filename);
  if (["js", "jsx", "mjs"].includes(extension)) return "javascript";
  if (["ts", "tsx"].includes(extension)) return "typescript";
  if (["md", "mdx", "markdown"].includes(extension)) return "markdown";
  if (["yaml", "yml"].includes(extension)) return "yaml";
  if (["html", "htm"].includes(extension)) return "html";
  return ({ py: "python", sh: "sh", json: "json", css: "css", csv: "csv",
    xml: "xml", sql: "sql" } as Record<string, string>)[extension] ?? "";
}

/** Render attachments into deterministic Markdown suitable for an agent prompt. */
export function formatSkillAttachments(raw: unknown, heading: string): string {
  const inspected = inspectSkillAttachments(raw);
  if (inspected.attachments.length === 0 && inspected.skipped === 0) return "";
  const parts = [`### ${singleLine(heading) || "Attached context"}`];
  if (inspected.skipped > 0) {
    parts.push(
      `> ${inspected.skipped} attached context item(s) could not be loaded and were skipped.`,
    );
  }
  for (const attachment of inspected.attachments) {
    const fence = fenceFor(attachment.text);
    const language = languageFor(attachment.filename);
    const note = attachment.truncated
      ? `\n\n[Attachment truncated to ${MAX_SKILL_ATTACHMENT_CHARS} characters.]`
      : "";
    parts.push([
      `#### ${attachment.filename}`,
      `Media type: ${attachment.mediaType}`,
      `${fence}${language}`,
      attachment.text,
      `${fence}${note}`,
    ].join("\n"));
  }
  return parts.join("\n\n");
}
