import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";

let cache: typeof import("./artifact-schema-cache.ts");
beforeEach(async () => {
  vi.resetModules();
  cache = await import("./artifact-schema-cache.ts");
});

describe("artifact schema cache", () => {
  it("reuses validators across deserialized copies and preserves validation", () => {
    const schema = { type: "object", required: ["result"], properties: { result: { type: "string" } } };
    const validate = cache.artifactValidator(schema);
    for (let i = 0; i < 100; i++) {
      expect(cache.artifactValidator(JSON.parse(JSON.stringify(schema)))).toBe(validate);
    }
    expect(validate({ result: "done" })).toBe(true);
    expect(validate({ result: 42 })).toBe(false);
    expect(validate.errors).toContainEqual(expect.objectContaining({ instancePath: "/result", keyword: "type" }));
    expect(cache.artifactValidatorCacheStats().schemas).toBe(1);
  });

  it("isolates changed schemas, including reused IDs and caller mutations", () => {
    const schema = { $id: "urn:minions:result", type: "string", enum: ["first"] };
    const first = cache.artifactValidator(schema);
    schema.enum[0] = "second";
    const second = cache.artifactValidator(schema);
    expect(second).not.toBe(first);
    expect(first("first")).toBe(true);
    expect(first("second")).toBe(false);
    expect(second("second")).toBe(true);
    expect(second("first")).toBe(false);
  });

  it("evicts least recently used validators when the count budget is reached", () => {
    const schema = (i: number) => ({ type: "string", minLength: i });
    const first = cache.artifactValidator(schema(0));
    const second = cache.artifactValidator(schema(1));
    for (let i = 2; i < cache.MAX_CACHED_ARTIFACT_SCHEMAS; i++) cache.artifactValidator(schema(i));
    expect(cache.artifactValidator(schema(0))).toBe(first);
    cache.artifactValidator(schema(cache.MAX_CACHED_ARTIFACT_SCHEMAS));
    expect(cache.artifactValidatorCacheStats().schemas).toBe(cache.MAX_CACHED_ARTIFACT_SCHEMAS);
    expect(cache.artifactValidator(schema(0))).toBe(first);
    expect(cache.artifactValidator(schema(1))).not.toBe(second);
  });

  it("bounds UTF-8 schema bytes before the count budget is reached", () => {
    const description = "漢😀".repeat(60_000);
    const schema = (i: number) => ({ type: "string", minLength: i, description });
    for (let i = 0; i < 3; i++) cache.artifactValidator(schema(i));
    expect(cache.artifactValidatorCacheStats()).toEqual({
      schemas: 2,
      schemaBytes: Buffer.byteLength(JSON.stringify(schema(1))) + Buffer.byteLength(JSON.stringify(schema(2))),
    });
    expect(cache.artifactValidatorCacheStats().schemaBytes).toBeLessThanOrEqual(cache.MAX_CACHED_ARTIFACT_SCHEMA_BYTES);
  });

  it("validates oversized schemas without retaining them or discarding hot entries", () => {
    const hot = cache.artifactValidator({ type: "number" });
    const before = cache.artifactValidatorCacheStats();
    const schema = { type: "string", description: "x".repeat(cache.MAX_CACHED_ARTIFACT_SCHEMA_BYTES) };
    const validate = cache.artifactValidator(schema);
    expect(validate("valid")).toBe(true);
    expect(validate(42)).toBe(false);
    expect(cache.artifactValidatorCacheStats()).toEqual(before);
    expect(cache.artifactValidator({ type: "number" })).toBe(hot);
  });

  it("keeps local references and boolean schemas working and does not cache compilation failures", () => {
    const validate = cache.artifactValidator({
      $defs: { result: { type: "string" } }, $ref: "#/$defs/result",
    });
    expect(validate("valid")).toBe(true);
    expect(validate(42)).toBe(false);
    expect(cache.artifactValidator(true)(42)).toBe(true);
    expect(cache.artifactValidator(false)(42)).toBe(false);
    const before = cache.artifactValidatorCacheStats();
    expect(() => cache.artifactValidator({ type: "invalid-type" })).toThrow();
    expect(cache.artifactValidatorCacheStats()).toEqual(before);
  });

  it("keeps retained heap stable through repeated persisted graph reads", async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [
      "--max-old-space-size=256", "--expose-gc", "--import", "./scripts/register-typescript.mjs",
      "tests/stability/graph-validation.mjs",
    ], { cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024 });
    expect(stdout, stderr || "Memory fixture produced no sample output").not.toBe("");
    const evidence = JSON.parse(stdout);
    expect(evidence.samples).toHaveLength(4);
    expect(evidence.churnSamples).toHaveLength(4);
  }, 35_000);
});
