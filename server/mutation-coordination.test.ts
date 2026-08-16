import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveEditCoordinator } from "./live-edit-coordinator.ts";
import { RunMutationCoordination } from "./mutation-coordination.ts";

const dirs: string[] = [];
function setup() {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "mutation-coordination-"));
  dirs.push(projectPath); fs.writeFileSync(path.join(projectPath, "a.ts"), "a");
  let token = 0;
  const coordinator = createLiveEditCoordinator({ projectPath,
    token: () => `token-${++token}`, defaultTtlMs: 20_000 });
  return { projectPath, coordinator };
}
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0))
  fs.rmSync(dir, { recursive: true, force: true }); });

describe("RunMutationCoordination", () => {
  it("reuses and revalidates a matching explicit intent without releasing it", async () => {
    const { projectPath, coordinator } = setup();
    const bridge = new RunMutationCoordination(coordinator, projectPath, "work", "run", 1_000);
    const lease = await bridge.openIntent("intent", [{ path: "a.ts", scope: "file" }]);
    await bridge.beforeTool("write", { operation: "write", paths: ["a.ts"], opaque: false });
    fs.writeFileSync(path.join(projectPath, "a.ts"), "own change");
    bridge.finishTool("write", "success");
    await expect(bridge.beforeTool("write-again",
      { operation: "write", paths: ["a.ts"], opaque: false })).resolves.toBeUndefined();
    bridge.finishTool("write-again", "success");
    expect(coordinator.snapshotRun("run").active).toHaveLength(1);
    expect(coordinator.snapshotRun("run").active[0]?.token).toBe(lease.token);
    bridge.closeIntent(lease.token);
    expect(coordinator.snapshotRun("run").state).toBe("clean");
  });

  it("retains and refreshes an explicit intent after reentrant path expansion", async () => {
    const { projectPath, coordinator } = setup();
    const bridge = new RunMutationCoordination(coordinator, projectPath, "work", "run", 1_000);
    const lease = await bridge.openIntent("intent", [{ path: "a.ts", scope: "file" }]);
    await bridge.beforeTool("create-b", { operation: "write", paths: ["b.ts"], opaque: false });
    fs.writeFileSync(path.join(projectPath, "b.ts"), "first");
    bridge.finishTool("create-b", "success");
    await expect(bridge.beforeTool("write-b",
      { operation: "write", paths: ["b.ts"], opaque: false })).resolves.toBeUndefined();
    fs.writeFileSync(path.join(projectPath, "b.ts"), "second");
    bridge.finishTool("write-b", "success");
    expect(coordinator.snapshotRun("run").active).toHaveLength(1);
    bridge.closeIntent(lease.token);
  });

  it("clears the execution pin and closes an explicit intent when refresh fails", async () => {
    const { projectPath, coordinator } = setup();
    const bridge = new RunMutationCoordination(coordinator, projectPath, "work", "run", 1_000);
    const lease = await bridge.openIntent("intent", [{ path: "a.ts", scope: "file" }]);
    await bridge.beforeTool("write", { operation: "write", paths: ["a.ts"], opaque: false });
    vi.spyOn(coordinator, "refresh").mockImplementation(() => { throw new Error("read denied"); });
    expect(bridge.finishTool("write", "success")).toContain("read denied");
    expect(coordinator.snapshotRun("run").state).toBe("clean");
    expect(() => bridge.closeIntent(lease.token)).toThrow("not active for this run");
  });

  it("claims opaque shell repository scope, heartbeats, and releases on error", async () => {
    vi.useFakeTimers(); const { projectPath, coordinator } = setup(); const events: string[] = [];
    coordinator.subscribe((event) => events.push(event.type));
    const bridge = new RunMutationCoordination(coordinator, projectPath, "work", "run", 100);
    await bridge.beforeTool("shell", { operation: "shell", paths: [], opaque: true });
    expect(coordinator.snapshotRun("run").active[0]?.paths[0]?.path).toBe(".");
    vi.advanceTimersByTime(100);
    expect(events).toContain("heartbeat");
    bridge.finishTool("shell", "error");
    expect(coordinator.snapshotRun("run").state).toBe("clean");
  });

  it("normalizes SDK absolute paths and uses prefix scope for destructive routes", async () => {
    const { projectPath, coordinator } = setup();
    const bridge = new RunMutationCoordination(coordinator, projectPath, "work", "run");
    await bridge.beforeTool("rename", { operation: "rename",
      paths: [path.join(projectPath, "a.ts")], opaque: false });
    expect(coordinator.snapshotRun("run").active[0]?.paths).toEqual([
      expect.objectContaining({ path: "a.ts", scope: "prefix" }),
    ]);
    bridge.finishTool("rename", "success");
  });

  it("hard-fences task-scoped mutations before any live-edit lease is acquired", async () => {
    const { projectPath,coordinator }=setup();
    const bridge=new RunMutationCoordination(coordinator,projectPath,"work","run",1_000,
      [{path:"a.ts",scope:"file"}]);
    await expect(bridge.beforeTool("allowed",{operation:"write",paths:["a.ts"],opaque:false}))
      .resolves.toBeUndefined();
    bridge.finishTool("allowed","success");
    await expect(bridge.beforeTool("outside",{operation:"write",paths:["b.ts"],opaque:false}))
      .rejects.toThrow("mutation exceeds task ownership scope: b.ts");
    await expect(bridge.beforeTool("opaque",{operation:"shell",paths:[],opaque:true}))
      .rejects.toThrow("mutation exceeds task ownership scope: .");
    expect(coordinator.snapshotRun("run").state).toBe("clean");
  });

  it("cancels a queued tool before it can mutate", async () => {
    const { projectPath, coordinator } = setup();
    const first = new RunMutationCoordination(coordinator, projectPath, "work-a", "run-a");
    const second = new RunMutationCoordination(coordinator, projectPath, "work-b", "run-b");
    const lease = await first.openIntent("hold", [{ path: "a.ts", scope: "file" }]);
    const waiting = second.beforeTool("queued", { operation: "write", paths: ["a.ts"], opaque: false });
    second.cancelTool("queued");
    await expect(waiting).rejects.toThrow("cancelled");
    first.closeIntent(lease.token);
  });

  it("signals the harness when an explicit intent reaches max hold outside a tool", async () => {
    vi.useFakeTimers(); const { projectPath } = setup();
    const coordinator = createLiveEditCoordinator({ projectPath,
      defaultTtlMs: 100, maxHoldMs: 150, token: () => "expiring" });
    const bridge = new RunMutationCoordination(coordinator, projectPath, "work", "run", 50);
    const lost = vi.fn(); bridge.setLeaseLostHandler(lost);
    await bridge.openIntent("long", [{ path: "a.ts", scope: "file" }]);
    // Advance past (rather than exactly onto) maxHoldAt so fake-timer interval
    // boundary ordering cannot defer the terminal heartbeat sweep.
    vi.advanceTimersByTime(151);
    expect(lost).toHaveBeenCalledOnce();
  });

  it("extends max hold only while a known mutation tool remains in flight", async () => {
    vi.useFakeTimers(); const { projectPath } = setup();
    const coordinator = createLiveEditCoordinator({ projectPath,
      defaultTtlMs: 100, maxHoldMs: 150, token: () => crypto.randomUUID() });
    const first = new RunMutationCoordination(coordinator, projectPath, "work-1", "run-1", 50);
    await first.beforeTool("long", { operation: "write", paths: ["a.ts"], opaque: false });
    let granted = false;
    const waiting = coordinator.claim({ requestId: "waiting", workItemId: "work-2", runKey: "run-2",
      paths: [{ path: "a.ts", scope: "file" }] }).then((lease) => { granted = true; return lease; });
    await vi.advanceTimersByTimeAsync(500);
    expect(granted).toBe(false); expect(coordinator.snapshotRun("run-1").state).toBe("editing");
    first.finishTool("long", "success"); const next = await waiting;
    expect(next.runKey).toBe("run-2"); coordinator.release(next.token);
  });

  it("keeps an executing mutation pinned when no heartbeat timer can run", async () => {
    const { projectPath } = setup(); let now = 0;
    const coordinator = createLiveEditCoordinator({ projectPath, now: () => now,
      defaultTtlMs: 100, maxHoldMs: 150, token: () => crypto.randomUUID() });
    const first = new RunMutationCoordination(coordinator, projectPath, "work-1", "run-1", 60_000);
    await first.beforeTool("long", { operation: "write", paths: ["a.ts"], opaque: false });
    now = 1_000;
    let granted = false;
    const waiting = coordinator.claim({ requestId: "waiting-no-heartbeat",
      workItemId: "work-2", runKey: "run-2",
      paths: [{ path: "a.ts", scope: "file" }] }).then((lease) => {
      granted = true; return lease;
    });
    await Promise.resolve();
    expect(granted).toBe(false);
    expect(coordinator.snapshotRun("run-1").state).toBe("editing");
    first.finishTool("long", "success");
    const next = await waiting;
    expect(next.runKey).toBe("run-2"); coordinator.release(next.token);
  });
});
