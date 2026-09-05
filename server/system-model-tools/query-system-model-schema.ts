import { z } from "zod/v4";
import { systemModelObjectTypeSchema } from "../../shared/system-model/index.ts";
import { DISCOVERY_RELATIONSHIPS } from "../system-model/discovery-relations.ts";

export const FACETS = ["summary", "entryPoints", "files", "tests", "behavior", "decisions", "constraints"] as const;
export type Facet = typeof FACETS[number];
const textBytes = (max: number) => z.string().max(max).refine((text) => Buffer.byteLength(text) <= max);

export const querySystemModelInputSchema = z.object({
  operation: z.enum(["search", "read", "expand"]).optional()
    .describe("Defaults to read with ids, otherwise search. Search never opens neighbors."),
  query: textBytes(4096).optional(),
  objectTypes: z.array(systemModelObjectTypeSchema).max(7).optional(),
  ids: z.array(textBytes(512).refine((id) => id.length > 0)).max(32).optional()
    .describe("Exact IDs or the short ref returned for an oversized ID. Refs are bound to the loaded model snapshot."),
  files: z.array(textBytes(512).refine((file) => file.length > 0)).max(32).optional()
    .describe("Repository-relative ranking hints for search; not an applicability verdict."),
  facets: z.array(z.enum(FACETS)).max(7).optional()
    .describe("Read complete selected facets. Omit for a compact preview; references do not open neighbors."),
  relationships: z.array(z.enum(DISCOVERY_RELATIONSHIPS)).max(11).optional(),
  direction: z.enum(["out", "in", "both"]).optional(),
  topK: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
    .describe("Page size: default 5, capped at 10. Follow page.nextCursor for more."),
  maxResponseBytes: z.number().int().min(2048).max(16384).optional()
    .describe("UTF-8 bytes of the serialized normalized handler result, including its text wrapper. Default 16384."),
  cursor: z.string().max(512).optional()
    .describe("Repeat the original arguments with page.nextCursor. Oversized entries use reassemblable JSON-string fragments."),
}).strict();

export function normalizeQuery(input: unknown) {
  if (Buffer.byteLength(JSON.stringify(input) ?? "") > 32768) throw new Error("Request too large");
  const args = querySystemModelInputSchema.parse(input);
  const ids = args.ids ?? [];
  const operation = args.operation ?? (ids.length ? "read" : "search");
  const query = args.query?.trim() ?? "";
  const files = [...new Set((args.files ?? []).map(normalizeFile))].sort();
  if (operation === "search" && (ids.length || (!query && !files.length))) throw new Error("Search intent required");
  if (operation !== "search" && !ids.length) throw new Error("IDs required");
  if (operation !== "search" && (files.length || (args.operation && query))) throw new Error("Incompatible search fields");
  if (operation !== "read" && args.facets !== undefined) throw new Error("Read facets only");
  if (operation !== "expand" && (args.relationships !== undefined || args.direction !== undefined)) throw new Error("Expansion fields only");
  return {
    operation, query: operation === "search" ? query : "", ids, files,
    objectTypes: [...new Set(args.objectTypes ?? [])].sort(),
    facets: FACETS.filter((facet) => args.facets?.includes(facet)),
    relationships: [...new Set(args.relationships ?? [])].sort(), direction: args.direction ?? "both",
    topK: Math.min(args.topK ?? 5, 10), maxResponseBytes: args.maxResponseBytes ?? 16384, cursor: args.cursor,
  };
}
export type Query = ReturnType<typeof normalizeQuery>;

function normalizeFile(value: string): string {
  const file = value.replaceAll("\\", "/");
  if (file.startsWith("/") || /^[a-z]:/i.test(file) || file.split("/").includes("..")) throw new Error("Files must be repository-relative");
  const normalized = file.split("/").filter((part) => part && part !== ".").join("/");
  if (!normalized) throw new Error("Empty file");
  return normalized;
}
