import { z } from "zod/v4";
import {
  semanticGraphDependencySchema,
  semanticGraphPlanStepSchema,
  semanticTaskGraphPlanSchema,
  type SemanticTaskGraphPlan,
} from "../../shared/task-graph-planning-contracts.ts";
import {
  taskGraphIterationSchema,
  taskGraphPatternProvenanceSchema,
  taskGraphProblemSignatureSchema,
} from "../../shared/task-graph-patterns.ts";
import { TaskGraphConflictError, TaskGraphValidationError } from "./errors.ts";

const revisionSchema = z.number().int().nonnegative();
const stepKeySchema = z.string().trim().min(1).max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const graphDocumentHeaderSchema = z.object({
  objective: z.string().trim().min(1),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
  nonGoals: z.array(z.string().trim().min(1)).default([]),
  constraints: z.array(z.string().trim().min(1)).default([]),
  assumptions: z.array(z.string().trim().min(1)).default([]),
  questions: z.array(z.string().trim().min(1)).max(1).default([]),
  workPacketId: z.string().min(1).nullable().optional(),
  pattern: taskGraphPatternProvenanceSchema.nullable().optional(),
  problemSignature: taskGraphProblemSignatureSchema.optional(),
  iteration: taskGraphIterationSchema.optional(),
  terminalStepKeys: z.array(stepKeySchema).min(1).optional(),
  maxActiveAttempts: z.number().int().min(1).max(100).default(4),
  budgetLimits: z.object({
    tokenLimit: z.number().int().nonnegative().nullable(),
    costMicrosLimit: z.number().int().nonnegative().nullable(),
  }).optional(),
});

export const initializeGraphDocumentSchema = z.object({
  expectedDocumentRevision: revisionSchema,
  plan: graphDocumentHeaderSchema,
});

export const graphDocumentNodeSchema = semanticGraphPlanStepSchema.omit({ dependsOn: true });
export const upsertGraphDocumentNodeSchema = z.object({
  expectedDocumentRevision: revisionSchema,
  node: graphDocumentNodeSchema,
});
export const removeGraphDocumentNodeSchema = z.object({
  expectedDocumentRevision: revisionSchema,
  stepKey: stepKeySchema,
});

export const graphDocumentEdgeSchema = semanticGraphDependencySchema.extend({
  sourceStepKey: stepKeySchema,
  targetStepKey: stepKeySchema,
}).omit({ stepKey: true });
const graphDocumentEdgeIdentitySchema = graphDocumentEdgeSchema.pick({
  sourceStepKey: true,
  targetStepKey: true,
  kind: true,
  sourceOutput: true,
  targetInput: true,
});
export const upsertGraphDocumentEdgeSchema = z.object({
  expectedDocumentRevision: revisionSchema,
  edge: graphDocumentEdgeSchema,
});
export const removeGraphDocumentEdgeSchema = graphDocumentEdgeIdentitySchema.extend({
  expectedDocumentRevision: revisionSchema,
});
export const inspectGraphDocumentSchema = z.object({
  view: z.enum(["compact", "full"]).default("compact"),
});
export const submitGraphDocumentSchema = z.object({
  expectedDocumentRevision: revisionSchema,
  requestId: z.string().min(1),
  baseProposalRevision: z.number().int().positive().nullable().default(null),
});

type Header = z.infer<typeof graphDocumentHeaderSchema>;
type Node = z.infer<typeof graphDocumentNodeSchema>;
type Edge = z.infer<typeof graphDocumentEdgeSchema>;

export interface CompactGraphDocument {
  documentRevision: number;
  objective: string;
  acceptanceCriteria: string[];
  nodes: Array<{
    key: string;
    title: string;
    dependsOn: string[];
    contextSelectors: string[];
  }>;
  edges: Array<{
    sourceStepKey: string;
    targetStepKey: string;
    kind: Edge["kind"];
    sourceOutput: string | null;
    targetInput: string | null;
    optional: boolean;
    failurePolicy: Edge["failurePolicy"];
  }>;
  terminalStepKeys?: string[];
}

/** Session-local semantic plan builder. Canonical identity is still assigned only by submission. */
export class SemanticGraphDocumentDraft {
  private documentRevision = 0;
  private header: Header | null = null;
  private readonly nodes = new Map<string, Node>();
  private readonly edges = new Map<string, Edge>();

  initialize(raw: z.input<typeof graphDocumentHeaderSchema>, expectedRevision: number): CompactGraphDocument {
    this.assertRevision(expectedRevision);
    this.header = graphDocumentHeaderSchema.parse(raw);
    this.nodes.clear();
    this.edges.clear();
    this.documentRevision += 1;
    return this.compact();
  }

  upsertNode(raw: z.input<typeof graphDocumentNodeSchema>, expectedRevision: number): CompactGraphDocument {
    this.assertInitialized();
    this.assertRevision(expectedRevision);
    const node = graphDocumentNodeSchema.parse(raw);
    const previous = this.nodes.get(node.key);
    this.nodes.set(node.key, node);
    try {
      this.assertReferencesValid();
    } catch (error) {
      if (previous) this.nodes.set(node.key, previous);
      else this.nodes.delete(node.key);
      throw error;
    }
    this.documentRevision += 1;
    return this.compact();
  }

  removeNode(stepKey: string, expectedRevision: number): CompactGraphDocument {
    this.assertInitialized();
    this.assertRevision(expectedRevision);
    if (!this.nodes.has(stepKey)) throw new TaskGraphValidationError(`unknown graph document node: ${stepKey}`);
    if (this.header?.terminalStepKeys?.includes(stepKey)) {
      throw new TaskGraphValidationError(`cannot remove terminal graph document node: ${stepKey}`);
    }
    if ([...this.edges.values()].some((edge) => edge.sourceStepKey === stepKey
      || edge.targetStepKey === stepKey)) {
      throw new TaskGraphValidationError(`remove edges for graph document node ${stepKey} first`);
    }
    this.nodes.delete(stepKey);
    this.documentRevision += 1;
    return this.compact();
  }

  upsertEdge(raw: z.input<typeof graphDocumentEdgeSchema>, expectedRevision: number): CompactGraphDocument {
    this.assertInitialized();
    this.assertRevision(expectedRevision);
    const edge = graphDocumentEdgeSchema.parse(raw);
    if (edge.sourceStepKey === edge.targetStepKey) {
      throw new TaskGraphValidationError("a graph document node cannot depend on itself");
    }
    if (!this.nodes.has(edge.sourceStepKey) || !this.nodes.has(edge.targetStepKey)) {
      throw new TaskGraphValidationError("graph document edge has an unknown endpoint");
    }
    const key = edgeKey(edge);
    const previous = this.edges.get(key);
    this.edges.set(key, edge);
    try {
      this.assertReferencesValid();
    } catch (error) {
      if (previous) this.edges.set(key, previous);
      else this.edges.delete(key);
      throw error;
    }
    this.documentRevision += 1;
    return this.compact();
  }

  removeEdge(raw: z.input<typeof graphDocumentEdgeIdentitySchema>,
    expectedRevision: number): CompactGraphDocument {
    this.assertInitialized();
    this.assertRevision(expectedRevision);
    const edge = graphDocumentEdgeIdentitySchema.parse(raw);
    const key = edgeKey(edge);
    if (!this.edges.delete(key)) {
      throw new TaskGraphValidationError(
        `unknown graph document edge: ${edge.sourceStepKey} -> ${edge.targetStepKey}`,
      );
    }
    this.documentRevision += 1;
    return this.compact();
  }

  inspect(view: "compact" | "full"): CompactGraphDocument | {
    documentRevision: number; plan: SemanticTaskGraphPlan;
  } {
    this.assertInitialized();
    return view === "compact"
      ? this.compact()
      : { documentRevision: this.documentRevision, plan: this.semanticPlan(false) };
  }

  submissionPlan(expectedRevision: number): SemanticTaskGraphPlan {
    this.assertInitialized();
    this.assertRevision(expectedRevision);
    return this.semanticPlan(true);
  }

  private semanticPlan(validate: boolean): SemanticTaskGraphPlan {
    const plan = {
      ...this.header!,
      steps: this.orderedNodes().map((node) => ({
        ...node,
        dependsOn: this.orderedEdges()
          .filter((edge) => edge.targetStepKey === node.key)
          .map(({ sourceStepKey, targetStepKey: _target, ...dependency }) => ({
            ...dependency, stepKey: sourceStepKey,
          })),
      })),
    };
    return validate
      ? semanticTaskGraphPlanSchema.parse(plan)
      : plan as SemanticTaskGraphPlan;
  }

  private compact(): CompactGraphDocument {
    const incoming = new Map<string, string[]>();
    for (const edge of this.orderedEdges()) {
      incoming.set(edge.targetStepKey, [...(incoming.get(edge.targetStepKey) ?? []), edge.sourceStepKey]);
    }
    return {
      documentRevision: this.documentRevision,
      objective: this.header!.objective,
      acceptanceCriteria: this.header!.acceptanceCriteria,
      nodes: this.orderedNodes().map((node) => ({
        key: node.key,
        title: node.title,
        dependsOn: incoming.get(node.key) ?? [],
        contextSelectors: node.contextSelectors,
      })),
      edges: this.orderedEdges().map((edge) => ({
        sourceStepKey: edge.sourceStepKey,
        targetStepKey: edge.targetStepKey,
        kind: edge.kind,
        sourceOutput: edge.sourceOutput,
        targetInput: edge.targetInput,
        optional: edge.optional,
        failurePolicy: edge.failurePolicy,
      })),
      ...(this.header!.terminalStepKeys
        ? { terminalStepKeys: this.header!.terminalStepKeys }
        : {}),
    };
  }

  private assertReferencesValid(): void {
    for (const edge of this.edges.values()) {
      const source = this.nodes.get(edge.sourceStepKey);
      const target = this.nodes.get(edge.targetStepKey);
      if (!source || !target) throw new TaskGraphValidationError("graph document edge has an unknown endpoint");
      if (edge.kind === "control" && (edge.sourceOutput || edge.targetInput)) {
        throw new TaskGraphValidationError(
          `control edge ${edge.sourceStepKey} -> ${edge.targetStepKey} cannot declare artifact bindings; set sourceOutput and targetInput to null or use an artifact kind`,
        );
      }
      if (edge.kind !== "control" && (!edge.sourceOutput || !edge.targetInput)) {
        throw new TaskGraphValidationError(
          `artifact edge ${edge.sourceStepKey} -> ${edge.targetStepKey} requires sourceOutput and targetInput`,
        );
      }
      if (edge.kind !== "control" && !(edge.sourceOutput! in source.outputSchemas)) {
        throw new TaskGraphValidationError(
          `artifact edge ${edge.sourceStepKey} -> ${edge.targetStepKey} sourceOutput "${edge.sourceOutput}" is not declared in ${edge.sourceStepKey}.outputSchemas`,
        );
      }
      if (edge.kind !== "control" && !(edge.targetInput! in target.inputBindings)) {
        throw new TaskGraphValidationError(
          `artifact edge ${edge.sourceStepKey} -> ${edge.targetStepKey} targetInput "${edge.targetInput}" is not declared in ${edge.targetStepKey}.inputBindings`,
        );
      }
    }
  }

  private orderedNodes(): Node[] {
    return [...this.nodes.values()].sort((left, right) => left.key.localeCompare(right.key));
  }

  private orderedEdges(): Edge[] {
    return [...this.edges.values()].sort((left, right) =>
      edgeKey(left).localeCompare(edgeKey(right)));
  }

  private assertInitialized(): void {
    if (!this.header) throw new TaskGraphValidationError("graph document is not initialized");
  }

  private assertRevision(expected: number): void {
    if (expected !== this.documentRevision) {
      throw new TaskGraphConflictError("stale graph document revision", {
        documentRevision: this.documentRevision,
        ...(this.header ? { document: this.compact() } : {}),
      });
    }
  }
}

function edgeKey(edge: Pick<Edge,"sourceStepKey"|"targetStepKey"|"kind"|"sourceOutput"|"targetInput">): string {
  return [edge.sourceStepKey,edge.targetStepKey,edge.kind,edge.sourceOutput??"",edge.targetInput??""]
    .join("\u0000");
}
