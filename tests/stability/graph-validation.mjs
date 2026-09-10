// Run with: node --expose-gc --import ./scripts/register-typescript.mjs tests/stability/graph-validation.mjs
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { initDb } from "../../server/db.ts";
import { TaskGraphRepository } from "../../server/task-graph/repository.ts";
import { artifactValidator, artifactValidatorCacheStats } from "../../server/task-graph/artifact-schema-cache.ts";

assert.equal(typeof global.gc, "function", "Run this regression with --expose-gc");
const db = initDb(":memory:");
try {
  const repo = new TaskGraphRepository(db);
  repo.createRevision({
    definitionId: "memory-definition", revisionId: "memory-revision",
    workItemId: "memory-work", workspaceId: "memory-workspace",
    objective: "Exercise repeated persisted graph reads", acceptanceCriteria: ["bounded heap"],
    terminalNodeIds: ["node-19"], maxActiveAttempts: 1, edges: [],
    nodes: Array.from({ length: 20 }, (_, i) => ({
      id: `node-${i}`, title: "Fixture node", objective: "Produce evidence",
      executorClass: "standard", allowedHarnesses: ["codex"], timeoutMs: 1000,
      retryPolicy: { maxAttempts: 1, backoffMs: 0, retryableOutcomes: [] },
      failurePolicy: "fail_graph",
      outputSchemas: { result: {
        type: "object", required: ["summary", "evidence"],
        properties: {
          summary: { type: "string" },
          evidence: { type: "array", items: {
            type: "object", required: ["path", "result"],
            properties: { path: { type: "string" }, result: { type: "string" } },
          } },
        },
      } },
    })),
  }, 1);
  const samples = [];
  for (let batch = 0; batch < 4; batch++) {
    for (let i = 0; i < 100; i++) repo.getRevision("memory-revision");
    await setImmediate(); global.gc(); await setImmediate(); global.gc();
    samples.push({ reads: (batch + 1) * 100, heapMiB: process.memoryUsage().heapUsed / 2 ** 20 });
  }
  assert.ok(samples.at(-1).heapMiB - samples[0].heapMiB < 8,
    "Repeated graph reads retain compiled schemas after warmup");
  // Reusing fixed contracts alone would miss a compiler that retains evicted
  // schemas. Exercise more distinct contracts than the cache can hold.
  const churnSamples = [];
  for (let batch = 0; batch < 4; batch++) {
    for (let i = 0; i < 150; i++) artifactValidator({
      type: "object", description: `contract-${batch * 150 + i}`,
      required: ["result"], properties: { result: { type: "string" } },
    });
    await setImmediate(); global.gc(); await setImmediate(); global.gc();
    churnSamples.push({ compiled: (batch + 1) * 150,
      heapMiB: process.memoryUsage().heapUsed / 2 ** 20, ...artifactValidatorCacheStats() });
  }
  writeSync(1, JSON.stringify({ samples, churnSamples }) + "\n");
  assert.ok(churnSamples.at(-1).heapMiB - churnSamples[0].heapMiB < 8,
    "Evicted artifact validators remain retained by their compiler");
} finally {
  db.close();
}
