import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionHost } from "./session-host.ts";
import { SessionRegistry } from "./session-registry.ts";
import { buildAgentContext } from "./session-host-agent-context.ts";
import { createBus } from "./bus.ts";
import { closePersistDb, openPersistDb, persistenceDb } from "./session-persist.ts";
import { createWorkItem, startWorkItemIteration } from "./work-item-repo.ts";
import { seedTaskName } from "./session-task-name.ts";
import { captureSessionContinuity } from "./session-continuity.ts";

beforeEach(() => openPersistDb(":memory:"));
afterEach(() => closePersistDb());

function selectName(host: SessionHost, name: string) {
  const bus = createBus({ clients: new Set() } as unknown as Parameters<typeof createBus>[0]);
  return buildAgentContext(host, { sessionKey: host.id, cwd: host.cwd, prompt: "Follow up" },
    { bus, startChildSession: () => {}, forEachLeaderTaskState: () => {} }).updateTaskName!(name);
}

function leader(id = "leader") {
  const host = new SessionHost(id, "/tmp");
  host.role = "leader";
  seedTaskName(host, "Please fix the callbacks");
  return host;
}

describe("canonical leader names", () => {
  it("preserves the selected name across follow-up prompts and server recovery", () => {
    const host = leader();
    selectName(host, "Repair OAuth callback handling");
    captureSessionContinuity(host, { sessionKey: host.id, cwd: host.cwd, prompt: "Now test it" });
    const registry = new SessionRegistry();
    registry.hydrateFromDb();
    const restored = registry.get(host.id)!;
    expect(selectName(restored, "Run callback tests")).toBe("Repair OAuth callback handling");
    expect(restored.taskName).toBe("Repair OAuth callback handling");
  });

  it("allows the first selection after recovering a prompt fallback", () => {
    const host = leader();
    host.persist();
    const registry = new SessionRegistry();
    registry.hydrateFromDb();
    expect(selectName(registry.get(host.id)!, "Repair OAuth callback handling"))
      .toBe("Repair OAuth callback handling");
  });

  it("protects existing names from snapshots predating canonical naming", () => {
    const host = leader();
    host.taskName = "Existing durable task name";
    delete host.continuity.canonicalTaskName;
    host.persist();
    const registry = new SessionRegistry();
    registry.hydrateFromDb();
    expect(selectName(registry.get(host.id)!, "A different name"))
      .toBe("Existing durable task name");
  });

  it("inherits the canonical primary name in later iterations of the same work item", () => {
    const db = persistenceDb()!;
    createWorkItem(db, { id: "work", projectId: "project", projectPath: "/tmp",
      title: "Initial prompt", changeMode: "live", at: 1 });
    startWorkItemIteration(db, { workItemId: "work", runKey: "first", idempotencyKey: "start",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null, at: 2 });
    const first = leader("first");
    first.workItemId = "work";
    selectName(first, "Repair OAuth callback handling");
    const next = new SessionHost("next", "/tmp");
    next.role = "leader";
    next.workItemId = "work";
    seedTaskName(next, "Now add regression tests");
    expect(next.taskName).toBe("Repair OAuth callback handling");
    expect(selectName(next, "Add regression tests")).toBe("Repair OAuth callback handling");
    const unrelated = leader("unrelated");
    expect(unrelated.continuity.canonicalTaskName).toBeNull();
  });
});
