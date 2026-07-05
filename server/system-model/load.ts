import fs from "fs";
import path from "path";
import { z } from "zod/v4";
import {
  capabilitySchema,
  constraintSchema,
  contextBudgetSchema,
  decisionMetaSchema,
  flowSchema,
  freshnessPolicySchema,
  reviewGateSchema,
  riskSchema,
  systemModelPoliciesSchema,
  type SystemModelObject,
} from "../../shared/system-model/index.ts";
import type { LoadedSystemModel, ModelValidationError } from "./types.ts";
import { validateLoadedSystemModel } from "./validate.ts";
import { parseYamlSubset } from "./yaml-parser.ts";

const MANIFEST = ".systemmodel/manifest.yaml";

export function manifestPathFor(cwd: string): string {
  return path.join(cwd, MANIFEST);
}

export function hasSystemModelManifest(cwd: string): boolean {
  return fs.existsSync(manifestPathFor(cwd));
}

export function loadSystemModel(cwd: string): {
  model: LoadedSystemModel | null;
  errors: ModelValidationError[];
} {
  const root = path.join(cwd, ".systemmodel");
  const manifestPath = path.join(root, "manifest.yaml");
  const errors: ModelValidationError[] = [];
  if (!fs.existsSync(manifestPath)) {
    return { model: null, errors: [{ file: MANIFEST, message: "manifest.yaml not found" }] };
  }

  const manifest = readYamlFile(manifestPath, z.record(z.string(), z.unknown()), errors) ?? {};
  const capabilities = readYamlDir(root, "capabilities", capabilitySchema, errors);
  const flows = readYamlDir(root, "flows", flowSchema, errors);
  const constraints = readYamlDir(root, "constraints", constraintSchema, errors);
  const decisions = readDecisionDir(root, errors);
  const risks = readRisks(root, errors);
  const policies = readPolicies(root, errors);
  const objects = [...capabilities, ...flows, ...constraints, ...decisions, ...risks];
  const duplicateErrors = findDuplicateIds(objects);

  const model: LoadedSystemModel = {
    root,
    manifestPath,
    manifest,
    capabilities,
    flows,
    constraints,
    decisions,
    risks,
    policies,
    objectsById: new Map(objects.map((object) => [object.id, object])),
    reviewGatesById: new Map(policies.reviewGates.map((gate) => [gate.id, gate])),
  };
  errors.push(...duplicateErrors, ...validateLoadedSystemModel(model));
  return { model: errors.length === 0 ? model : null, errors };
}

function readYamlDir<T>(
  root: string,
  dir: string,
  schema: z.ZodType<T>,
  errors: ModelValidationError[],
): T[] {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full)
    .filter((file) => /\.ya?ml$/i.test(file))
    .sort()
    .flatMap((file) => {
      const value = readYamlFile(path.join(full, file), schema, errors);
      return value ? [value] : [];
    });
}

function readYamlFile<T>(
  file: string,
  schema: z.ZodType<T>,
  errors: ModelValidationError[],
): T | null {
  const rel = displayFile(file);
  try {
    const doc = parseYamlSubset(fs.readFileSync(file, "utf-8"));
    if (doc.errors.length > 0) {
      errors.push(...doc.errors.map((message) => ({ file: rel, message })));
      return null;
    }
    const parsed = schema.safeParse(doc.value);
    if (!parsed.success) {
      errors.push({ file: rel, message: z.prettifyError(parsed.error) });
      return null;
    }
    return parsed.data;
  } catch (err) {
    errors.push({ file: rel, message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

function readDecisionDir(root: string, errors: ModelValidationError[]): ReturnType<typeof decisionMetaSchema.parse>[] {
  const dir = path.join(root, "decisions");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((file) => /\.md$/i.test(file))
    .sort()
    .flatMap((file) => {
      const full = path.join(dir, file);
      const text = fs.readFileSync(full, "utf-8");
      const front = parseFrontMatter(text);
      const fallbackTitle = text.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(file, ".md");
      const data = {
        type: "decision",
        title: fallbackTitle,
        summary: fallbackTitle,
        ...front,
        file: path.relative(root, full),
      };
      const parsed = decisionMetaSchema.safeParse(data);
      if (!parsed.success) {
        errors.push({ file: displayFile(full), message: z.prettifyError(parsed.error) });
        return [];
      }
      return [parsed.data];
    });
}

function parseFrontMatter(text: string): Record<string, unknown> {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const doc = parseYamlSubset(match[1]!);
  return doc.errors.length === 0 && typeof doc.value === "object" && doc.value !== null
    ? doc.value as Record<string, unknown>
    : {};
}

function readRisks(root: string, errors: ModelValidationError[]) {
  const file = path.join(root, "risks.yaml");
  if (!fs.existsSync(file)) return [];
  const schema = z.union([
    z.array(riskSchema),
    z.object({ risks: z.array(riskSchema).default([]) }).transform((v) => v.risks),
  ]);
  return readYamlFile(file, schema, errors) ?? [];
}

function readPolicies(root: string, errors: ModelValidationError[]) {
  const policiesRoot = path.join(root, "policies");
  const freshness = readPolicyList(policiesRoot, "freshness.yaml", "freshness", freshnessPolicySchema, errors);
  const reviewGates = readPolicyList(policiesRoot, "review-gates.yaml", "reviewGates", reviewGateSchema, errors);
  const contextBudgets = readContextBudgets(policiesRoot, errors);
  return systemModelPoliciesSchema.parse({ freshness, reviewGates, contextBudgets });
}

function readPolicyList<T>(
  dir: string,
  file: string,
  key: string,
  schema: z.ZodType<T>,
  errors: ModelValidationError[],
): T[] {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) return [];
  const listSchema = z.union([
    z.array(schema),
    z.object({ [key]: z.array(schema).default([]) }).transform((v) => v[key] as T[]),
  ]);
  return readYamlFile(full, listSchema, errors) ?? [];
}

function readContextBudgets(dir: string, errors: ModelValidationError[]) {
  const file = path.join(dir, "context-budgets.yaml");
  if (!fs.existsSync(file)) return undefined;
  const schema = z.union([
    contextBudgetSchema,
    z.object({ contextBudgets: contextBudgetSchema }).transform((v) => v.contextBudgets),
  ]);
  return readYamlFile(file, schema, errors) ?? undefined;
}

function findDuplicateIds(objects: SystemModelObject[]): ModelValidationError[] {
  const seen = new Set<string>();
  const errors: ModelValidationError[] = [];
  for (const object of objects) {
    if (seen.has(object.id)) errors.push({ file: object.id, message: `Duplicate object id ${object.id}` });
    seen.add(object.id);
  }
  return errors;
}

function displayFile(file: string): string {
  const marker = `${path.sep}.systemmodel${path.sep}`;
  const idx = file.indexOf(marker);
  return idx >= 0 ? `.systemmodel/${file.slice(idx + marker.length).replaceAll(path.sep, "/")}` : file;
}
