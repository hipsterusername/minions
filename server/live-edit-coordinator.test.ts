import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveEditCoordinator, LiveEditBaselineConflictError } from "./live-edit-coordinator.ts";
import { canonicalizeLiveEditPaths, liveEditPathsOverlap } from "./live-edit-paths.ts";

describe("volatile live-edit coordinator", () => {
  let root: string; let now: number; let token: number;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "live-edit-")); now = 1_000; token = 0;
    fs.mkdirSync(path.join(root, "src")); fs.writeFileSync(path.join(root, "src/a.ts"), "one"); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const coordinator = () => createLiveEditCoordinator({ projectPath: root, now: () => now,
    token: () => `token-${++token}`, maxHoldMs: 100_000 });
  const claim = (c: ReturnType<typeof coordinator>, requestId: string, runKey: string,
    paths = [{ path: "src/a.ts", scope: "file" as const }], workItemId = runKey) =>
    c.claim({ requestId, runKey, workItemId, paths });

  it("rejects traversal and symlink escape and detects file/prefix overlap", () => {
    expect(() => canonicalizeLiveEditPaths(root, [{ path: "../escape", scope: "file" }])).toThrow(/escapes/);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    try { fs.symlinkSync(outside, path.join(root, "link"));
      expect(() => canonicalizeLiveEditPaths(root, [{ path: "link/x", scope: "file" }])).toThrow(/symlink/);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
    const [prefix] = canonicalizeLiveEditPaths(root, [{ path: "src", scope: "prefix" }]);
    const [file] = canonicalizeLiveEditPaths(root, [{ path: "src/a.ts", scope: "file" }]);
    expect(liveEditPathsOverlap(prefix!, file!)).toBe(true);
  });

  it("allows disjoint concurrency and atomically queues overlapping multi-path/rename claims", async () => {
    fs.writeFileSync(path.join(root, "src/b.ts"), "b"); const c = coordinator();
    const first = await claim(c, "one", "run-1");
    const disjoint = await claim(c, "two", "run-2", [{ path: "src/b.ts", scope: "file" }]);
    let granted = false;
    const rename = claim(c, "rename", "run-3", [{ path: "src/a.ts", scope: "file" },
      { path: "src/c.ts", scope: "file" }]).then((lease) => { granted = true; return lease; });
    await Promise.resolve(); expect(granted).toBe(false);
    c.release(disjoint.token); expect(granted).toBe(false);
    c.release(first.token); expect((await rename).paths.map((entry) => entry.path)).toEqual(["src/a.ts", "src/c.ts"]);
  });

  it("preserves FIFO for conflicting waiters without blocking a later disjoint claim", async () => {
    fs.writeFileSync(path.join(root, "src/b.ts"), "b"); const c = coordinator(); const order: string[] = [];
    const held = await claim(c, "held", "held");
    const q1 = claim(c, "q1", "run-1").then((lease) => { order.push("q1"); return lease; });
    const q2 = claim(c, "q2", "run-2").then((lease) => { order.push("q2"); return lease; });
    const free = await claim(c, "free", "run-3", [{ path: "src/b.ts", scope: "file" }]);
    expect(free.runKey).toBe("run-3"); c.release(held.token); const first = await q1;
    expect(order).toEqual(["q1"]); c.release(first.token); await q2; expect(order).toEqual(["q1", "q2"]);
  });

  it("refreshes queue positions after an earlier waiter is cancelled", async () => {
    const c = coordinator(); const events: Array<{ type: string; requestId?: string; queuePosition?: number }> = [];
    c.subscribe((event) => events.push(event)); await claim(c, "held", "held");
    const q1 = claim(c, "q1", "run-1"); const q2 = claim(c, "q2", "run-2");
    c.cancel("q1"); await expect(q1).rejects.toThrow(/cancelled/);
    expect(events.filter((event) => event.type === "queued" && event.requestId === "q2").at(-1))
      .toMatchObject({ queuePosition: 1 });
    c.restart(); await expect(q2).rejects.toThrow(/cancelled/);
  });

  it("is idempotent by request id, reuses a run token, and rejects unsafe reentrant expansion", async () => {
    fs.writeFileSync(path.join(root, "src/b.ts"), "b"); const c = coordinator();
    const other = await claim(c, "other", "other", [{ path: "src/b.ts", scope: "file" }]);
    const first = await claim(c, "same", "run", undefined, "work");
    expect((await claim(c, "same", "run", undefined, "work")).token).toBe(first.token);
    await expect(claim(c, "expand", "run", [{ path: "src/b.ts", scope: "file" }], "work"))
      .rejects.toThrow(/close the existing intent/);
    c.release(first.token); c.release(other.token);
    expect(c.snapshotRun("run").state).toBe("clean");
  });

  it("queues a different run of the same work item instead of rejecting", async () => {
    const c = coordinator(); const held = await claim(c, "one", "parent", undefined, "work");
    let resolved = false; const child = claim(c, "two", "child", undefined, "work").then((lease) => { resolved = true; return lease; });
    await Promise.resolve(); expect(resolved).toBe(false); c.release(held.token); expect((await child).runKey).toBe("child");
  });

  it("deduplicates queued retries and opaque shell claims cover the repository", async () => {
    fs.writeFileSync(path.join(root, "src/b.ts"), "b"); const c = coordinator();
    const shell = await c.claim({ requestId: "shell", workItemId: "shell", runKey: "shell",
      paths: [], opaqueShell: true });
    const request = { requestId: "retry", workItemId: "work", runKey: "run",
      paths: [{ path: "src/b.ts", scope: "file" as const }] };
    const first = c.claim(request); const retry = c.claim(request); c.release(shell.token);
    const [a, b] = await Promise.all([first, retry]); expect(a.token).toBe(b.token);
    expect(a.paths).toMatchObject([{ path: "src/b.ts" }]);
  });

  it("captures absence/content baselines and detects pre-mutation changes", async () => {
    const c = coordinator(); const events: Array<{ type: string; runState: string; workItemState: string }> = [];
    c.subscribe((event) => events.push(event)); const lease = await claim(c, "one", "run", [
      { path: "src/a.ts", scope: "file" }, { path: "src/new.ts", scope: "file" }]);
    fs.writeFileSync(path.join(root, "src/a.ts"), "changed"); fs.writeFileSync(path.join(root, "src/new.ts"), "created");
    expect(() => c.revalidate(lease.token)).toThrow(LiveEditBaselineConflictError);
    c.heartbeat(lease.token);
    expect(events.at(-1)).toMatchObject({ type: "heartbeat", runState: "waiting", workItemState: "waiting" });
    c.release(lease.token); expect(c.snapshotRun("run").state).toBe("clean");
  });

  it("keeps work-item aggregate editing when one of multiple runs releases", async () => {
    fs.writeFileSync(path.join(root, "src/b.ts"), "b"); const c = coordinator(); const events: Array<{ type: string; workItemState: string }> = [];
    c.subscribe((event) => events.push(event)); const one = await claim(c, "one", "run-1", undefined, "work");
    const two = await claim(c, "two", "run-2", [{ path: "src/b.ts", scope: "file" }], "work");
    expect(c.snapshotWorkItem("work").state).toBe("editing"); c.release(one.token);
    expect(events.at(-1)).toMatchObject({ type: "released", workItemState: "editing" });
    expect(c.snapshotWorkItem("work").active).toHaveLength(1); c.release(two.token);
    expect(c.snapshotWorkItem("work").state).toBe("clean");
  });

  it("does not allow an explicit close to release an in-flight mutation", async () => {
    const c = coordinator(); const lease = await claim(c, "intent", "run");
    c.beginMutation(lease.token);
    expect(() => c.closeIntent(lease.token)).toThrow(/mutation is in flight/);
    expect(c.snapshotRun("run").state).toBe("editing");
    c.endMutation(lease.token); expect(c.closeIntent(lease.token)).toBe(true);
  });

  it("expires on TTL/max hold, wakes waiters, and cleans disconnect/restart", async () => {
    const c = coordinator(); const held = await claim(c, "one", "run-1");
    const waiting = claim(c, "two", "run-2"); now += 30_001; c.sweep();
    expect((await waiting).runKey).toBe("run-2"); expect(() => c.heartbeat(held.token)).toThrow(/not active/);
    c.disconnect("run-2"); expect(c.snapshotRun("run-2").state).toBe("clean"); c.restart();
  });

  it("heartbeats extend TTL but never exceed max hold", async () => {
    const c = createLiveEditCoordinator({ projectPath: root, now: () => now,
      token: () => `token-${++token}`, defaultTtlMs: 30_000, maxHoldMs: 50_000 });
    const lease = await claim(c, "one", "run"); now += 25_000;
    expect(c.heartbeat(lease.token).expiresAt).toBe(51_000);
    now = 51_001; c.sweep(); expect(c.snapshotRun("run").state).toBe("clean");
  });

  it("cancels queued intents and restart clears all volatile state", async () => {
    const c = coordinator(); await claim(c, "held", "run-1");
    const queued = claim(c, "queued", "run-2"); expect(c.cancel("queued")).toBe(true);
    await expect(queued).rejects.toThrow(/cancelled/); c.restart();
    expect(c.snapshotRun("run-1").state).toBe("clean");
  });

  it("isolates subscriber exceptions so grants resolve and other listeners observe them", async () => {
    const c = coordinator(); const observed = vi.fn(); c.subscribe(() => { throw new Error("observer failed"); }); c.subscribe(observed);
    await expect(claim(c, "one", "run")).resolves.toMatchObject({ token: "token-1" });
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({ type: "granted", acquiredAt: 1_000 }));
  });
});
