import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionHost, type StartSessionOptions } from "./session-host.ts";
import { SessionRegistry } from "./session-registry.ts";
import { closePersistDb, openPersistDb, removePersistedSession } from "./session-persist.ts";
import { captureSessionContinuity } from "./session-continuity.ts";
import { buildPendingCompactionStartOptions } from "./proactive-compaction.ts";
import { compileContextCheckpoint, renderCheckpointPrompt } from "./context-checkpoint.ts";
import { buildHarnessStartOpts } from "./session-host-run.ts";
import type { AgentHarness } from "./harness/types.ts";
import type { AgentTypeContext } from "./agents/types.ts";
import { createSqliteWorkItemService, type WorkItemInvocation } from "./work-item-service-sqlite.ts";
import { createBus } from "./bus.ts";

beforeEach(() => openPersistDb(":memory:"));
afterEach(() => closePersistDb());

function leader() {
  const host = new SessionHost("handoff-leader", "/tmp");
  host.role = "leader";
  host.sessionId = "old-provider";
  return host;
}
function options(prompt: string, extras: Partial<StartSessionOptions> = {}): StartSessionOptions {
  return { sessionKey: "handoff-leader", cwd: "/tmp", prompt, ...extras };
}
function boundary(host: SessionHost, opts: StartSessionOptions) {
  return buildHarnessStartOpts({ host, opts, prompt: opts.prompt,
    abortController: new AbortController(), agentCtx: {} as AgentTypeContext,
    agentType: { id: "default", wantsWorktree: false, buildSystemPrompt: () => "",
      getToolGroups: () => ({ toolGroups: {}, mcpToolNames: [] }) },
    toolResult: { toolGroups: {}, mcpToolNames: [] },
    harness: { name: "test", builtInTools: [], capabilities: {}, resolveModel: () => null } as unknown as AgentHarness,
  }).startOpts;
}

describe("provider-boundary handoff regressions", () => {
  it("preserves original instructions, corrections, decisions and recent evidence across repeated forced resets", () => {
    const host = leader();
    captureSessionContinuity(host, options("Migrate the API. PRESERVE_V1."));
    captureSessionContinuity(host, options("CORRECTION: use the blue deployment."));
    host.contextCheckpoint = compileContextCheckpoint(host, { trigger: "proactive", originalPrompt: "Continue",
      modelHandoff: "Goal: Migrate safely\nDecisions:\n- Keep v1 because callers depend on it\nDead ends:\n- Avoid schema rewrite\nNext actions:\n- Verify compatibility", persist: false });
    host.bufferEvent({ type: "sdk_event", sessionKey: host.id, timestamp: Date.now(), event: { kind: "text", role: "assistant", text: "EVIDENCE: compatibility suite passes; rollout remains." } });
    for (let index = 0; index < 3; index++) {
      host.proactiveCompaction.forcePending = { action: "force" } as never;
      const next = buildPendingCompactionStartOptions(host, options("Continue", { resumeId: host.sessionId! }))!;
      const launched = boundary(host, next);
      expect(launched.resumeId).toBeUndefined();
      for (const sentinel of ["PRESERVE_V1", "CORRECTION", "callers depend", "Avoid schema rewrite", "Verify compatibility", "EVIDENCE"]) {
        expect(launched.prompt).toContain(sentinel);
      }
      expect(host.contextCheckpoint?.objective.statement).toBe("Migrate the API. PRESERVE_V1.");
      expect(host.contextCheckpoint?.userDirectives.join("\n")).not.toContain("<context-checkpoint");
    }
  });

  it("restores sources and images without a browser and respects an explicit clear after restart", () => {
    const host = leader();
    host.skillIds = ["risk-based-code-review"];
    host.skillSnapshotId = "a".repeat(64);
    host.skillValues = { "risk-based-code-review": { depth: "high" } };
    captureSessionContinuity(host, options("Keep the old endpoint"));
    const attachment = { kind: "image", mediaType: "image/png", data: "aW1hZ2U=" } as const;
    host.setCanvasContext("<connected-context>REQUIRED_SPEC</connected-context>", [attachment]);
    const registry = new SessionRegistry();
    registry.hydrateFromDb();
    const restored = registry.get(host.id)!;
    expect(restored.skillIds).toEqual(host.skillIds);
    expect(restored.skillSnapshotId).toBe(host.skillSnapshotId);
    expect(restored.skillValues).toEqual(host.skillValues);
    expect(restored.continuity.directives).toEqual(["Keep the old endpoint"]);
    const launched = boundary(restored, options("Continue"));
    expect(launched.prompt).toContain("REQUIRED_SPEC");
    expect(launched.prompt).toContain("Keep the old endpoint");
    expect(launched.attachments).toEqual([attachment]);
    restored.setCanvasContext(null);
    const secondRegistry = new SessionRegistry();
    secondRegistry.hydrateFromDb();
    const cleared = boundary(secondRegistry.get(host.id)!, options("Continue"));
    expect(cleared.prompt).not.toContain("REQUIRED_SPEC");
    expect(cleared.attachments).toBeUndefined();
    expect(removePersistedSession(host.id)).toBe(true);
    expect(openPersistDb().prepare("SELECT * FROM session_continuity").all()).toEqual([]);
  });

  it("includes earlier user events in overflow recovery and keeps large checkpoint sections well formed", () => {
    const host = leader();
    host.bufferEvent({ type: "sdk_event", sessionKey: host.id, timestamp: Date.now(), event: { kind: "text", role: "user", text: "EARLIER_USER_CONSTRAINT" } });
    const checkpoint = compileContextCheckpoint(host, { trigger: "context_recovery", originalPrompt: "Continue", persist: false });
    expect(checkpoint.recentEvents.join("\n")).toContain("user: EARLIER_USER_CONSTRAINT");
    checkpoint.userDirectives = ["ORIGINAL " + "x".repeat(50_000) + " LATEST_CORRECTION"];
    checkpoint.modelHandoff = "x".repeat(50_000);
    checkpoint.decisions = Array.from({ length: 100 }, () => ({ decision: "x".repeat(1_000), rationale: "why" }));
    const rendered = renderCheckpointPrompt(checkpoint);
    expect(rendered.length).toBeLessThanOrEqual(24_000);
    expect(rendered).toContain("ORIGINAL");
    expect(rendered).toContain("LATEST_CORRECTION");
    expect(rendered).toContain("omitted by handoff budget");
    expect(rendered).toContain("</user-directives>");
    expect(rendered).toContain("</decisions>");
    expect(rendered).toMatch(/<\/context-checkpoint>$/);
  });

  it("does not record generated checkpoints or automatic wake text as user directives", () => {
    const host = leader();
    captureSessionContinuity(host, options("ORIGINAL"));
    captureSessionContinuity(host, options("Task results: generated", { continuitySource: "system" }));
    captureSessionContinuity(host, options("<context-checkpoint>generated</context-checkpoint>", { contextCheckpointId: "cp" }));
    expect(host.continuity.directives).toEqual(["ORIGINAL"]);
  });

  it("adopts pinned UI instructions so the next compaction does not lose them", () => {
    const host = leader();
    captureSessionContinuity(host, options("<previous-session-context><user-directives>ORIGINAL\n\nCORRECTION</user-directives><conversation-history>assistant noise</conversation-history></previous-session-context>\nContinue"));
    const checkpoint = compileContextCheckpoint(host, { trigger: "proactive", originalPrompt: "Continue", persist: false });
    expect(checkpoint.userDirectives).toEqual(["ORIGINAL", "CORRECTION", "Continue"]);
    expect(checkpoint.objective.statement).toBe("ORIGINAL");
  });

  it("retains full oversized instructions durably while exposing their archive in bounded handoffs", () => {
    const host = leader();
    const original = "START " + "x".repeat(12_000) + " MIDDLE_REQUIREMENT " + "x".repeat(12_000) + " END";
    captureSessionContinuity(host, options(original));
    captureSessionContinuity(host, options(original));
    const rows = openPersistDb().prepare("SELECT text FROM session_user_directives WHERE session_key = ? ORDER BY id").all(host.id);
    expect(rows).toEqual([{ text: original }]);
    const checkpoint = compileContextCheckpoint(host, { trigger: "proactive", originalPrompt: "Continue", persist: false });
    const rendered = renderCheckpointPrompt(checkpoint);
    expect(rendered.length).toBeLessThanOrEqual(24_000);
    // This fixture has no durable filesystem database; never invent a read path.
    expect(rendered).not.toContain(":memory:");
    expect(rendered).toContain("START");
    expect(rendered).toContain("END");
  });

  it("preserves the order when the user reinstates an earlier instruction", () => {
    const host = leader();
    for (const text of ["Use red", "Use blue", "Use red"]) captureSessionContinuity(host, options(text));
    const checkpoint = compileContextCheckpoint(host, { trigger: "proactive", originalPrompt: "Use red", persist: false });
    expect(checkpoint.userDirectives).toEqual(["Use red", "Use blue", "Use red"]);
    expect(openPersistDb().prepare("SELECT text FROM session_user_directives WHERE session_key = ? ORDER BY id").all(host.id))
      .toEqual([{ text: "Use red" }, { text: "Use blue" }, { text: "Use red" }]);
  });

  it("hydrates pre-migration canonical skills and source context from durable run config", () => {
    const host = leader();
    host.persist();
    const db = openPersistDb();
    db.prepare("DELETE FROM session_continuity WHERE session_key = ?").run(host.id);
    db.prepare("UPDATE sessions SET run_config_json = ? WHERE session_key = ?").run(JSON.stringify({
      skillIds: ["review"], skillValues: { review: { depth: "high" } },
      userDirectives: ["ORIGINAL"], planningContext: "<connected-context>SPEC</connected-context>",
    }), host.id);
    const registry = new SessionRegistry();
    registry.hydrateFromDb();
    const restored = registry.get(host.id)!;
    expect(restored.skillIds).toEqual(["review"]);
    expect(restored.skillValues).toEqual({ review: { depth: "high" } });
    expect(boundary(restored, options("Continue")).prompt).toContain("SPEC");
  });

  it.each(["provider-switch", "missing-resume", "compatible-resume"])("supplies durable context on %s and retains compatible resume behavior", async (scenario) => {
    const launches: WorkItemInvocation[] = [];
    const db = openPersistDb();
    const service = createSqliteWorkItemService({ db, bus: createBus({ clients: new Set() } as never),
      generateKey: (kind, id) => `${kind}-${id}`, launchRun: input => { launches.push(input); }, continueRun: () => {},
    });
    const created = await service.create({ requestId: "create", projectId: "project", projectPath: "/tmp", title: "Migrate safely", changeMode: "live" });
    let detail = await service.startRun({ requestId: "first", workItemId: created.workItem.id, prompt: "ORIGINAL_DIRECTIVE", harness: "codex",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null });
    if (scenario !== "missing-resume") service.updateProviderSessionId("run-first", "provider-first");
    const prior = new SessionHost("run-first", "/tmp");
    prior.role = "leader";
    prior.sessionId = scenario !== "missing-resume" ? "provider-first" : null;
    prior.continuity.directives = ["ORIGINAL_DIRECTIVE", "MID_RUN_CORRECTION"];
    prior.persist();
    detail = service.sealPrimaryRun({ workItemId: created.workItem.id, runKey: "run-first", outcome: "completed", finalReport: "VERIFIED_REPORT",
      expectedLifecycleRevision: detail.workItem.lifecycle.lifecycleRevision, expectedCurrentRunKey: "run-first" });
    await service.startRun({ requestId: "second", workItemId: created.workItem.id, prompt: "Continue",
      harness: scenario === "provider-switch" ? "claude" : "codex",
      expectedLifecycleRevision: detail.workItem.lifecycle.lifecycleRevision, expectedCurrentRunKey: "run-first" });
    const launch = launches.at(-1)!;
    if (scenario === "compatible-resume") {
      expect(launch.resumeId).toBe("provider-first");
      expect(launch.prompt).toBe("Continue");
      expect(launch.freshThreadPrompt).toContain("VERIFIED_REPORT");
      return;
    }
    expect(launch.resumeId).toBeUndefined();
    for (const text of ["ORIGINAL_DIRECTIVE", "MID_RUN_CORRECTION", "VERIFIED_REPORT", "Continue"]) expect(launch.prompt).toContain(text);
    expect(launch.userDirectives).toContain("MID_RUN_CORRECTION");
  });
});
