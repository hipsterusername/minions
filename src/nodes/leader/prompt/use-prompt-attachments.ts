import { createContext, useRef, useState, type ClipboardEvent } from "react";
import type { ContextAttachment, ContextItem } from "../../../types.ts";
import { randomUuid } from "../../../random-id.ts";
import { loadImageFromFile } from "../../image-loader.ts";

interface DraftAttachment {
  id: string;
  filename: string;
  item?: ContextItem;
  preview?: string;
  error?: string;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_EXTENSION = /\.(txt|md|mdx|csv|json|jsonl|yaml|yml|xml|html|css|js|jsx|ts|tsx|py|sh|sql|log)$/i;

async function readAttachment(file: File, id: string): Promise<Partial<DraftAttachment>> {
  if (IMAGE_TYPES.has(file.type)) {
    const image = await loadImageFromFile(file);
    const data = image.src.slice(image.src.indexOf(",") + 1);
    if (data.length > 6 * 1024 * 1024) throw new Error("Image is too large. Paste a smaller image.");
    return { preview: image.src, item: {
      nodeId: id, nodeType: "image", label: file.name || "Pasted image",
      content: `Attached image: ${file.name || "Pasted image"}`,
      attachments: [{ kind: "image", filename: image.filename,
        mediaType: image.mediaType as ContextAttachment["mediaType"], data }],
    } };
  }
  if (file.type.startsWith("text/") || TEXT_EXTENSION.test(file.name)) {
    if (file.size > 1024 * 1024) throw new Error("Text file is too large (maximum 1 MB).");
    const content = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(new Error("Could not read this file."));
      reader.readAsText(file);
    });
    return { item: { nodeId: id, nodeType: "file", label: file.name, content } };
  }
  throw new Error("Use PNG, JPEG, GIF, WebP, or a text file.");
}

/** Owned by the leader so drafts survive switching composer surfaces. */
export function usePromptAttachments() {
  const [drafts, setDrafts] = useState<DraftAttachment[]>([]);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const remove = (ids: string[]) => setDrafts(current => current.filter(draft => !ids.includes(draft.id)));
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboard = event.clipboardData;
    const files = Array.from(clipboard.files ?? []);
    if (!files.length) {
      for (const item of Array.from(clipboard.items ?? [])) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (!files.length) return;
    // Keep native insertion for accompanying text, but do not spawn canvas nodes.
    if (!clipboard.getData("text/plain")) event.preventDefault();
    event.stopPropagation();
    const pending = files.map(file => ({ id: randomUuid(), filename: file.name || "Pasted image" }));
    setDrafts(current => [...current, ...pending]);
    files.forEach((file, index) => {
      const draft = pending[index]!;
      void readAttachment(file, draft.id).catch((error: unknown) => ({
        error: error instanceof Error ? error.message : "Could not read this attachment.",
      })).then(result => setDrafts(current => current.map(entry => entry.id === draft.id
        ? { ...entry, ...result } : entry)));
    });
  };
  return { drafts, onPaste, remove,
    items: drafts.flatMap(draft => draft.item ? [draft.item] : []),
    blocked: drafts.some(draft => !draft.item),
    // Submission also checks the ref, protecting keyboard sends during decoding.
    canSubmit: () => draftsRef.current.every(draft => Boolean(draft.item)),
  };
}

export const PromptAttachmentsContext = createContext<ReturnType<typeof usePromptAttachments> | null>(null);
