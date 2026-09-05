import { createHash } from "node:crypto";
import type { SystemModelObject } from "../../shared/system-model/index.ts";
import { FACETS, type Facet } from "./query-system-model-schema.ts";

/** One mapping drives both advertised availability and complete facet reads. */
export function objectFacets(object: SystemModelObject): Partial<Record<Facet, unknown>> {
  const summary = summaryFor(object);
  switch (object.type) {
    case "domain": return { summary, behavior: pick(object, ["name", "summary", "keywords"]) };
    case "capability": return {
      summary, behavior: pick(object, ["name", "summary", "domain", "dependsOn", "bridges", "risk", "risks", "keywords"]), entryPoints: object.entryPoints,
      files: { suggestedFiles: object.suggestedFiles, entryPoints: object.entryPoints.map(({ surface, files }) => ({ surface, files })) },
      tests: { suggestedTests: object.suggestedTests, entryPoints: object.entryPoints.map(({ surface, tests }) => ({ surface, tests })) },
      decisions: object.decisions, constraints: object.constraints,
    };
    case "flow": return {
      summary, behavior: pick(object, ["name", "summary", "domain", "primaryCapability", "steps", "bridges", "risk", "risks"]),
      files: { suggestedFiles: object.suggestedFiles }, tests: { suggestedTests: object.suggestedTests }, decisions: object.decisions, constraints: object.constraints,
    };
    case "surface": return { summary, behavior: pick(object, ["name", "summary", "keywords"]),
      files: { suggestedFiles: object.suggestedFiles }, tests: { suggestedTests: object.suggestedTests } };
    case "constraint": return {
      summary, behavior: pick(object, ["statement", "agentInstruction", "domain", "scope", "guards", "appliesTo", "severity", "reviewGate", "evidence"]),
      files: { appliesToFiles: object.appliesTo.files }, tests: { suggestedTests: object.suggestedTests },
    };
    case "decision": return { summary, behavior: pick(object, ["title", "status", "summary", "evidence"]), ...(object.file ? { files: { documentFile: object.file } } : {}) };
    case "risk": return { summary, behavior: pick(object, ["summary", "domain", "severity", "appliesTo", "mitigation"]), files: { appliesToFiles: object.appliesTo.files } };
  }
}

export function objectReference(id: string, modelVersion: string): string {
  return `@${modelVersion}.${createHash("sha256").update(id).digest("hex")}`;
}

export function preview(object: SystemModelObject, summaryTokens: number, modelVersion?: string) {
  const label = "name" in object ? object.name : object.type === "constraint" ? object.statement : object.type === "decision" ? object.title : object.summary;
  const summary = summaryFor(object);
  const clippedLabel = clip(label, 120);
  const clippedSummary = clip(summary, Math.min(320, summaryTokens * 4));
  const previewTruncated = [clippedLabel !== label ? "label" : "", clippedSummary !== summary ? "summary" : ""].filter(Boolean);
  const facets = objectFacets(object);
  return { id: object.id, type: object.type, label: clippedLabel, summary: clippedSummary,
    ...(modelVersion && Buffer.byteLength(object.id) > 512 ? { ref: objectReference(object.id, modelVersion) } : {}),
    availableFacets: FACETS.filter((facet) => facet in facets), ...(previewTruncated.length ? { previewTruncated } : {}) };
}
export function readFacets(object: SystemModelObject, selected: Facet[]) {
  const available = objectFacets(object);
  return Object.fromEntries(selected.map((facet) => [facet, facet in available
    ? { status: "ok", value: available[facet] } : { status: "unavailable", reason: "not_modeled" }]));
}
export function clip(value: string, length: number): string {
  const points = Array.from(value);
  return points.length <= length ? value : `${points.slice(0, Math.max(0, length - 3)).join("")}...`;
}
function summaryFor(object: SystemModelObject): string { return object.type === "constraint" ? object.agentInstruction ?? object.statement : object.summary; }
function pick<T extends object>(object: T, keys: Array<keyof T>) {
  return Object.fromEntries(keys.filter((key) => object[key] !== undefined).map((key) => [key, object[key]]));
}
