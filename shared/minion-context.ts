import { z } from "zod/v4";

/** Leader-owned context, independent of provider-owned instructions and permissions. */
export const minionContextSchema = z.object({
  profile: z.enum(["standard", "compact"]).default("standard")
    .describe("standard: repository work and investigation; compact: small self-contained tasks. Changes only Minions instructions, not provider instructions, tools, or permissions."),
  role: z.string().trim().min(1).max(1_000).optional()
    .describe("Optional functional mandate, e.g. review correctness. Does not grant authority."),
  instructions: z.array(z.string().trim().min(1).max(4_000)).max(8).default([])
    .describe("Leader-authored task-specific instructions. Keep acceptance, ownership and output schemas in their dedicated fields."),
  references: z.array(z.object({
    id: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).max(100),
    title: z.string().trim().min(1).max(200),
    content: z.string().trim().min(1).max(12_000),
  }).strict()).max(12).default([])
    .describe("Bounded reference excerpts or summaries, treated as data, not instructions. Use canvas selectors for connected sources and artifact edges for upstream results."),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.references.map(ref => ref.id)).size !== value.references.length) {
    ctx.addIssue({ code: "custom", path: ["references"], message: "Reference IDs must be unique." });
  }
  const size = (value.role?.length ?? 0) + value.instructions.join("").length
    + value.references.reduce((sum, ref) => sum + ref.title.length + ref.content.length, 0);
  if (size > 24_000) ctx.addIssue({ code: "custom", message: "Minion context exceeds 24,000 characters; narrow excerpts or use artifact handoffs." });
});

export type MinionContext = z.infer<typeof minionContextSchema>;

/** Inspection views should not echo the full context into every Leader turn. */
export const minionContextSummarySchema = z.object({
  profile: z.enum(["standard", "compact"]),
  roleCharacters: z.number().int().nonnegative(),
  instructionCount: z.number().int().nonnegative(),
  instructionCharacters: z.number().int().nonnegative(),
  referenceIds: z.array(z.string()),
  referenceCharacters: z.number().int().nonnegative(),
});

export function summarizeMinionContext(context: MinionContext): z.infer<typeof minionContextSummarySchema> {
  return { profile: context.profile, roleCharacters: context.role?.length ?? 0,
    instructionCount: context.instructions.length,
    instructionCharacters: context.instructions.join("").length,
    referenceIds: context.references.map(ref => ref.id),
    referenceCharacters: context.references.reduce((sum, ref) => sum + ref.content.length, 0) };
}

export const MINION_CONTEXT_GUIDE = [
  { block: "context.profile", when: "Use compact for one-word answers, classification, or small supplied-text transformations; standard for coding, investigation, and substantial verification." },
  { block: "context.role / context.instructions", when: "Add a short functional mandate and task-specific operating rules. Never paste source documents or the Leader transcript here." },
  { block: "objective / acceptanceCriteria / constraints / ownershipRequest / outputSchemas", when: "Define the work, observable completion, invariants, permitted writes, and output contract here. These remain active for every profile." },
  { block: "context.references", when: "Pass short excerpts, examples, or a focused summary as reference data. Include provenance in the content. Do not copy whole logs or repeat selected canvas/skill content." },
  { block: "contextSelectors", when: "Use canvas:<sourceId> from the inventory for exact connected-source selection, or canvas:<title words>. repo:<path> is an applicability hint, not file-content injection. Empty selects no canvas context." },
  { block: "skillIds", when: "Set exact relevant frozen skill IDs. [] excludes optional Minions skills; omission inherits Leader-selected skills. Provider-owned skill catalogs are separate." },
  { block: "workPacketId", when: "Supply required project constraints and model guidance through a Work Packet. Context profiles cannot remove required constraints or bypass freshness/policy gates." },
  { block: "dependsOn / inputBindings", when: "Use typed artifact dependencies for predecessor results; do not paste their full transcripts. Runtime resolves immutable inputs." },
] as const;
