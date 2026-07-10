import type { SystemModelObject, SystemModelObjectType } from "../../shared/system-model/index.ts";
import type { LoadedSystemModel } from "./types.ts";

export const LOW_CONFIDENCE_FALLBACK = "inspect repo; ask only if required";

export interface MatchCandidate {
  id: string;
  type: SystemModelObjectType;
  score: number;
  reasons: string[];
}

export interface MatchResult {
  candidates: MatchCandidate[];
  matchConfidence: "high" | "medium" | "low";
  fallbackInstruction?: string;
}

export function matchSystemModel(input: {
  model: LoadedSystemModel;
  request: string;
  files?: string[];
  keywords?: string[];
  topK?: number;
}): MatchResult {
  const terms = tokenize([input.request, ...(input.keywords ?? [])].join(" "));
  const files = input.files ?? [];
  const candidates = [...input.model.objectsById.values()]
    .map((object) => scoreObject(object, terms, files))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, input.topK ?? 5);
  const best = candidates[0]?.score ?? 0;
  const matchConfidence = best >= 6 ? "high" : best >= 3 ? "medium" : "low";
  return {
    candidates,
    matchConfidence,
    ...(matchConfidence === "low" ? { fallbackInstruction: LOW_CONFIDENCE_FALLBACK } : {}),
  };
}

function scoreObject(object: SystemModelObject, terms: Set<string>, files: string[]): MatchCandidate {
  if (object.type === "capability") {
    return scoreFields(object, terms, files, {
      name: object.name,
      aux: { label: "keyword", terms: new Set(object.keywords.map(normalize)) },
      summary: object.summary,
      fileGlobs: object.suggestedFiles,
    });
  }
  if (object.type === "flow") {
    return scoreFields(object, terms, files, {
      name: object.name,
      aux: { label: "flow", terms: tokenize(object.steps.join(" ")) },
      summary: object.summary,
      fileGlobs: object.suggestedFiles,
    });
  }
  if (object.type === "constraint") {
    return scoreFields(object, terms, files, {
      name: object.statement,
      aux: { label: "instruction", terms: tokenize(object.agentInstruction ?? "") },
      fileGlobs: object.appliesTo.files,
    });
  }
  if (object.type === "decision") {
    return scoreFields(object, terms, files, {
      name: object.title,
      summary: object.summary,
    });
  }
  return scoreFields(object, terms, files, {
    summary: object.summary,
  });
}

function scoreFields(
  object: SystemModelObject,
  terms: Set<string>,
  files: string[],
  fields: {
    name?: string;
    aux?: { label: string; terms: Set<string> };
    summary?: string;
    fileGlobs?: string[];
  },
): MatchCandidate {
  const reasons: string[] = [];
  let score = 0;

  const nameHits = countHits(tokenize(fields.name ?? ""), terms);
  if (nameHits > 0) {
    score += nameHits * 3;
    reasons.push(`name matched ${nameHits} term${nameHits === 1 ? "" : "s"}`);
  }
  const auxHits = countHits(fields.aux?.terms ?? new Set<string>(), terms);
  if (auxHits > 0 && fields.aux) {
    score += auxHits * 2;
    reasons.push(`${fields.aux.label} matched ${auxHits} term${auxHits === 1 ? "" : "s"}`);
  }
  const summaryHits = countHits(tokenize(fields.summary ?? ""), terms);
  if (summaryHits > 0) {
    score += summaryHits;
    reasons.push(`summary matched ${summaryHits} term${summaryHits === 1 ? "" : "s"}`);
  }
  const fileHits = files.filter((file) => (fields.fileGlobs ?? []).some((glob) => globMatches(glob, file))).length;
  if (fileHits > 0) {
    score += fileHits * 4;
    reasons.push(`file matched ${fileHits} suggested path${fileHits === 1 ? "" : "s"}`);
  }
  return { id: object.id, type: object.type, score, reasons };
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9_./-]+/).map(normalize).filter(Boolean));
}

function normalize(term: string): string {
  return term.trim().toLowerCase();
}

function countHits(haystack: Set<string>, needles: Set<string>): number {
  let count = 0;
  for (const needle of needles) if (haystack.has(needle)) count += 1;
  return count;
}

export function globMatches(glob: string, file: string): boolean {
  const source = glob.split(/[/\\]+/).map(escapeGlobPart).join("[/\\\\]");
  return new RegExp(`^${source}$`).test(file);
}

function escapeGlobPart(part: string): string {
  if (part === "**") return ".*";
  return part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("\\*", "[^/\\\\]*");
}
