import type { LoadedSystemModel, ModelValidationError } from "./types.ts";
import { globMatches } from "./match.ts";

/** Validate authored path hints against an existing-file inventory, including new worktree files. */
export function validateFileAnchors(model: LoadedSystemModel, files: string[]): ModelValidationError[] {
  const errors: ModelValidationError[] = [];
  const existing = new Set(files);
  const matches = new Map<string, boolean>();
  const check = (owner: string, field: string, anchors: string[]) => {
    for (const anchor of new Set(anchors)) {
      if (!matches.has(anchor)) matches.set(anchor, existing.has(anchor)
        || (/[*?]/.test(anchor) && files.some((file) => globMatches(anchor, file))));
      if (!matches.get(anchor)) errors.push({ file: owner, path: field,
        message: `File anchor matches no existing file: ${anchor}`, severity: "warning" });
    }
  };
  for (const object of model.objectsById.values()) {
    if ("suggestedFiles" in object) check(object.id, "suggestedFiles", object.suggestedFiles);
    if ("suggestedTests" in object) check(object.id, "suggestedTests", object.suggestedTests);
    if ("appliesTo" in object) check(object.id, "appliesTo.files", object.appliesTo.files);
    if (object.type === "capability") for (const entry of object.entryPoints) {
      check(object.id, `entryPoints.${entry.surface}.files`, entry.files);
      check(object.id, `entryPoints.${entry.surface}.tests`, entry.tests);
    }
    if (object.type === "decision") check(object.id, "evidence", object.evidence);
  }
  for (const gate of model.policies.reviewGates) {
    check(gate.id, "requiredWhen.files", gate.requiredWhen.files);
    check(gate.id, "requiredChecks", (gate.requiredChecks ?? []).filter((row) => row.kind === "test").map((row) => row.target));
  }
  return errors;
}
