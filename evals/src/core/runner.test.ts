import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutionAdapter } from "./contracts.js";
import { EventStore, LifecycleRunner, ResultStore } from "./index.js";
import { taskManifest } from "../../tests/support/fixtures.js";

function fixtureAdapter(): ExecutionAdapter & { starts: number; terminal: boolean } {
  const handle = { schemaVersion: 1 as const, adapterId: "fixture", handleId: "h1", runId: "run-1", createdAt: "2026-01-01T00:00:00.000Z" };
  return { id: "fixture", version: "1", starts: 0, terminal: false, async preflight() { throw new Error("unused"); }, async start() { this.starts += 1; return handle; }, async *observe() {}, async inspect() { return { schemaVersion: 1 as const, handle, state: this.terminal ? "terminal" as const : "running" as const, terminalOutcome: this.terminal ? "completed" as const : null, participants: [], observedAt: "2026-01-01T00:00:00.000Z" }; }, async stop() { this.terminal = true; return { schemaVersion: 1 as const, handle, reason: "cancelled" as const, accepted: true, stoppedAt: "2026-01-01T00:00:00.000Z", descendantsAccountedFor: true }; }, async collect() { return { schemaVersion: 1 as const, handle, artifacts: [], provenance: {}, usageCoverage: "unavailable" as const, logTruncated: false }; } };
}
describe("LifecycleRunner", () => {
  it("persists a handle before recovery and never relaunches it", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-runner-")); const adapter = fixtureAdapter();
    const options = { experimentId: "experiment", aggregateTokenCap: 10, store: new ResultStore(join(root, "store.json")), events: new EventStore(join(root, "events.jsonl")) };
    const request = { cell: { schemaVersion: 1 as const, cellId: "cell", experimentId: "experiment", taskId: "task", adapterId: "fixture", repetition: 0, fixtureSeed: "seed", status: "planned" as const }, spec: { schemaVersion: 1 as const, runId: "run-1", idempotencyKey: "run-1", taskId: "task", prompt: "do work", workspace: { id: "workspace", mountPath: "/tmp/workspace" }, limits: taskManifest.limits, configuration: {}, visibleAssets: [] } };
    const runner = new LifecycleRunner(options, adapter);
    await runner.start(request); await new LifecycleRunner(options, adapter).start(request);
    expect(adapter.starts).toBe(1);
    adapter.terminal = true; await new LifecycleRunner(options, adapter).reconcile();
    expect((await options.store.getRun("run-1"))?.status).toBe("finalized");
  });
  it("cancels when aggregate budget or watchdog limits are exceeded", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-limits-")); const adapter = fixtureAdapter(); const options = { experimentId: "experiment", aggregateTokenCap: 10, store: new ResultStore(join(root, "store.json")), events: new EventStore(join(root, "events.jsonl")), now: () => new Date("2026-01-02T00:00:00.000Z") };
    const runner = new LifecycleRunner(options, adapter); const request = { cell: { schemaVersion: 1 as const, cellId: "cell", experimentId: "experiment", taskId: "task", adapterId: "fixture", repetition: 0, fixtureSeed: "seed", status: "planned" as const }, spec: { schemaVersion: 1 as const, runId: "run-1", idempotencyKey: "run-1", taskId: "task", prompt: "do work", workspace: { id: "workspace", mountPath: "/tmp/workspace" }, limits: taskManifest.limits, configuration: {}, visibleAssets: [] } };
    await runner.start(request); expect(await runner.enforceLimits("run-1", 11)).toBe(true); expect((await options.store.getRun("run-1"))?.cancellationRequested).toBe(true); expect(await runner.watchdog("run-1", new Date("2026-01-01T00:00:00.000Z"))).toBe(true);
  });
  it.each(["running", "ready"] as const)("persists grading after recovery from %s with a durable handle", async (status) => {
    const root = await mkdtemp(join(tmpdir(), "eval-grade-")); const adapter = fixtureAdapter();
    const options = { experimentId: "experiment", aggregateTokenCap: 10, store: new ResultStore(join(root, "store.json")), events: new EventStore(join(root, "events.jsonl")), snapshotSubmission: async () => ({ schemaVersion: 1 as const, submissionHash: "a".repeat(64), rootDigest: "a".repeat(64), files: [], capturedAt: "2026-01-01T00:00:00.000Z" }), graderContext: { schemaVersion: 1 as const, graderRevision: "r1", timeoutMs: 100, environment: {} } };
    const grader = { id: "fixture-grader", version: "1", async grade() { return { schemaVersion: 1 as const, gradeId: "grade-1", graderId: "fixture-grader", graderVersion: "1", graderRevision: "r1", submissionHash: "a".repeat(64), outcome: "passed" as const, criteria: [], regressionPassed: true, metrics: [], logReferences: [] }; } };
    const request = { cell: { schemaVersion: 1 as const, cellId: "cell", experimentId: "experiment", taskId: "task", adapterId: "fixture", repetition: 0, fixtureSeed: "seed", status: "planned" as const }, spec: { schemaVersion: 1 as const, runId: "run-1", idempotencyKey: "run-1", taskId: "task", prompt: "do work", workspace: { id: "workspace", mountPath: "/tmp/workspace" }, limits: taskManifest.limits, configuration: {}, visibleAssets: [] } };
    const runner = new LifecycleRunner(options, adapter, grader); await runner.start(request); await options.store.updateRun("run-1", {status}); adapter.terminal = true; await runner.reconcile();
    expect((await options.store.getResult("run-1"))?.gradeOutcome).toBe("passed");
    expect((await options.store.getResult("run-1"))?.submission?.submissionHash).toBe("a".repeat(64));
  });
});
