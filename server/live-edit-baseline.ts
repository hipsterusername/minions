import crypto from "node:crypto";
import fs from "node:fs";
import type { CanonicalLiveEditPath } from "./live-edit-paths.ts";

export interface LiveEditBaseline { path: string; state: "absent" | "file" | "other"; hash: string | null }

export function captureLiveEditBaseline(entry: CanonicalLiveEditPath): LiveEditBaseline | null {
  if (entry.scope !== "file") return null;
  try {
    const stat = fs.statSync(entry.absolutePath);
    if (!stat.isFile()) return { path: entry.path, state: "other", hash: null };
    return { path: entry.path, state: "file",
      hash: crypto.createHash("sha256").update(fs.readFileSync(entry.absolutePath)).digest("hex") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: entry.path, state: "absent", hash: null };
    throw error;
  }
}

export function sameLiveEditBaseline(a: LiveEditBaseline, b: LiveEditBaseline): boolean {
  return a.state === b.state && a.hash === b.hash;
}
