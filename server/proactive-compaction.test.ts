import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildProactiveCompactionSeed,
  createProactiveCompactionState,
  recordCompactionUsage,
} from "./proactive-compaction.ts";
import type { SessionHost } from "./session-host.ts";

describe("proactive compaction seed builder", () => {
  it("includes server-owned state and caps long task results", () => {
    const host = {
      sessionId: "old-thread",
      taskName: "Checkpoint work",
      cwd: "/repo",
      taskState: {
        tasks: new Map([
          ["t1", {
            taskId: "t1",
            title: "Implement",
            description: "Do it",
            priority: "high",
            executor: "leader",
            minionSessionKey: null,
            leaderSessionKey: "leader-1",
            status: "completed",
            createdAt: 1,
            completedAt: 2,
            result: "x".repeat(2_000),
          }],
        ]),
        pendingWait: null,
        approval: null,
      },
      renderState: {
        layout: { title: "Dash", columns: 2, gap: 12 },
        components: [{ id: "status", type: "status", label: "Tests", state: "success" }],
      },
      worktree: {
        path: "/repo/.worktrees/leader",
        branch: "minions/leader",
        projectPath: "/repo",
        createdAt: "now",
        lifecycle: "active",
      },
    } as unknown as SessionHost;

    const seed = buildProactiveCompactionSeed(host, "Next: verify and report.");

    expect(seed).toContain("<previous-session-context>");
    expect(seed).toContain("Prior session id: old-thread");
    expect(seed).toContain("- t1 [completed] Implement");
    expect(seed).toContain("truncated");
    expect(seed).toContain("- status: status");
    expect(seed).toContain("branch: minions/leader");
    expect(seed).toContain("Next: verify and report.");
  });
});

describe("proactive compaction setting resolution", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeProject(settings: Record<string, unknown> | null): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minions-compaction-"));
    tmpDirs.push(dir);
    if (settings) {
      fs.mkdirSync(path.join(dir, ".minions"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".minions", "settings.json"),
        JSON.stringify(settings),
      );
    }
    return dir;
  }

  function makeLeaderHost(cwd: string): SessionHost {
    return {
      role: "leader",
      cwd,
      worktree: null,
      model: "claude-fable-5",
      proactiveCompaction: createProactiveCompactionState(),
    } as unknown as SessionHost;
  }

  const usage = { kind: "usage", input: 10, output: 5, cacheRead: 0 } as const;

  it("resolves the project setting on first usage event", () => {
    const host = makeLeaderHost(makeProject({ proactiveCompaction: "off" }));
    recordCompactionUsage(host, usage);
    expect(host.proactiveCompaction.setting).toBe("off");
    expect(host.proactiveCompaction.settingResolved).toBe(true);
  });

  it("falls back to the default for invalid or absent values", () => {
    const invalid = makeLeaderHost(
      makeProject({ proactiveCompaction: "sometimes" }),
    );
    recordCompactionUsage(invalid, usage);
    expect(invalid.proactiveCompaction.setting).toBe("recommend");

    const absent = makeLeaderHost(makeProject(null));
    recordCompactionUsage(absent, usage);
    expect(absent.proactiveCompaction.setting).toBe("recommend");
  });

  it("respects an explicit pre-resolved setting", () => {
    const host = makeLeaderHost(makeProject({ proactiveCompaction: "off" }));
    host.proactiveCompaction.setting = "auto";
    host.proactiveCompaction.settingResolved = true;
    recordCompactionUsage(host, usage);
    expect(host.proactiveCompaction.setting).toBe("auto");
  });
});

