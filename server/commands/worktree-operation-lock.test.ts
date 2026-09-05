import { describe, expect, it } from "vitest";
import type { SessionHost } from "../session-host.ts";
import { beginWorktreeOperation, hasWorktreeOperation, trackWorktreeExecution } from "./worktree-operation-lock.ts";
const host = () => ({ status: "idle", worktree: { path: "/repo/.canvas-worktrees/shared" },
  runControl: null, eventStream: null, taskState: null }) as SessionHost;

describe("worktree execution ownership", () => {
  it("retains ownership after stop until all invocations using the checkout drain", () => {
    const leader = host(), child = host();
    const releaseFirst = trackWorktreeExecution(child), releaseSecond = trackWorktreeExecution(child);
    child.status = "stopped";
    expect(beginWorktreeOperation(leader, "merge")).toBeNull();
    releaseFirst(); releaseFirst();
    expect(beginWorktreeOperation(leader, "discard")).toBeNull();
    releaseSecond();
    const lease = beginWorktreeOperation(leader, "merge"); expect(lease).not.toBeNull(); lease!.release();
  });
  it("locks the shared path against another host and new launches", () => {
    const leader = host(), child = host();
    const lease = beginWorktreeOperation(leader, "merge")!;
    expect(beginWorktreeOperation(child, "discard")).toBeNull();
    expect(hasWorktreeOperation(child)).toBe(true);
    lease.release(); expect(hasWorktreeOperation(child)).toBe(false);
  });
});
