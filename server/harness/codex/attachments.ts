/**
 * Codex attachment scratch management.
 *
 * Materialises base64 image attachments to disk so the Codex SDK's
 * `local_image` UserInput variant (which requires file paths) can reference
 * them. Each session gets its own scratch directory under
 * `<tmpdir>/minions-codex-attachments/<sessionKey>/`.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UserInput } from "@openai/codex-sdk";
import type { NormalizedAttachment } from "../types.ts";

const SCRATCH_ROOT = "minions-codex-attachments";

/**
 * Session keys must be safe for use as a single directory-name component.
 * Reject anything that could escape the scratch root via path traversal.
 */
const SESSION_KEY_RE = /^[A-Za-z0-9_-]+$/;

export interface CodexAttachmentScratch {
  /** Absolute path of the per-session scratch directory. */
  readonly dir: string;
  /** Image inputs to pass to thread.runStreamed alongside the text input. */
  readonly inputs: UserInput[];
  /** Idempotent. Removes the entire scratch directory. */
  dispose(): Promise<void>;
}

/**
 * Materialise attachments to disk as the Codex SDK requires file paths
 * (it has no base64 input variant). Returns scratch metadata plus
 * `local_image` UserInput entries the harness merges with the text input.
 */
export async function writeCodexAttachments(opts: {
  sessionKey: string;
  attachments: ReadonlyArray<NormalizedAttachment>;
}): Promise<CodexAttachmentScratch> {
  if (!SESSION_KEY_RE.test(opts.sessionKey)) {
    throw new Error(
      `writeCodexAttachments: invalid sessionKey "${opts.sessionKey}". ` +
        "Session keys must match [A-Za-z0-9_-]+.",
    );
  }

  const dir = path.join(os.tmpdir(), SCRATCH_ROOT, opts.sessionKey);

  // Wipe any prior run for this session key so writes are idempotent.
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });

  const inputs: UserInput[] = [];

  for (const [i, att] of opts.attachments.entries()) {
    const ext = mediaTypeToExt(att.mediaType);
    const filePath = path.join(dir, `attachment-${i}.${ext}`);
    await fs.writeFile(filePath, Buffer.from(att.data, "base64"));
    inputs.push({ type: "local_image", path: filePath });
  }

  return makeScratch(dir, inputs);
}

/**
 * Build the full `Input` (string | UserInput[]) for thread.runStreamed
 * from a text prompt and attachment scratch. If there are zero image inputs
 * and a non-empty prompt string, return the string; otherwise return an
 * array with one text input followed by every image input.
 */
export function buildCodexInput(
  prompt: string,
  scratch: CodexAttachmentScratch | null,
): string | UserInput[] {
  if (scratch === null || scratch.inputs.length === 0) {
    return prompt;
  }
  // Even when prompt is empty, the SDK requires at least one input entry.
  return [{ type: "text", text: prompt }, ...scratch.inputs];
}

function makeScratch(dir: string, inputs: UserInput[]): CodexAttachmentScratch {
  return {
    dir,
    inputs,
    async dispose(): Promise<void> {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/** Map a MIME mediaType to the corresponding file extension. */
function mediaTypeToExt(mediaType: NormalizedAttachment["mediaType"]): string {
  switch (mediaType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default: {
      // Exhaustiveness guard — TypeScript will catch unhandled variants at
      // compile time; this branch only runs if the type system is bypassed.
      const _exhaustive: never = mediaType;
      throw new Error(`writeCodexAttachments: unexpected mediaType "${String(_exhaustive)}"`);
    }
  }
}
