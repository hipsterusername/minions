import Ajv, { type AnySchema, type ValidateFunction } from "ajv";

export const MAX_CACHED_ARTIFACT_SCHEMAS = 64;
export const MAX_CACHED_ARTIFACT_SCHEMA_BYTES = 1024 * 1024;

const cache = new Map<string, { validate: ValidateFunction; bytes: number }>();
let schemaBytes = 0;

export function artifactValidatorCacheStats() {
  return { schemas: cache.size, schemaBytes };
}

/** Graph reads reconstruct schema objects; reuse validators by JSON content. */
export function artifactValidator(schema: unknown): ValidateFunction {
  const key = JSON.stringify(schema);
  if (key === undefined) throw new Error("artifact output schema must be JSON");
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.validate;
  }

  // A shared Ajv instance retains every reconstructed schema by identity.
  // Give each cached validator its own compiler so eviction also releases
  // compiler-owned schema environments and generated-code references.
  const compiler = new Ajv({ strict: false, allErrors: true });
  const validate = compiler.compile(JSON.parse(key) as AnySchema);
  const bytes = Buffer.byteLength(key);
  // Large contracts remain valid; they are compiled without cache residency.
  if (bytes > MAX_CACHED_ARTIFACT_SCHEMA_BYTES) return validate;
  while (cache.size >= MAX_CACHED_ARTIFACT_SCHEMAS
    || schemaBytes + bytes > MAX_CACHED_ARTIFACT_SCHEMA_BYTES) {
    const oldest = cache.keys().next().value!;
    schemaBytes -= cache.get(oldest)!.bytes;
    cache.delete(oldest);
  }
  cache.set(key, { validate, bytes });
  schemaBytes += bytes;
  return validate;
}
