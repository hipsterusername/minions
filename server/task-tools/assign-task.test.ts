/**
 * Tests for the assign_task MCP tool.
 *
 * The behaviours these lock in:
 *   1. With no skillIds, the minion's systemPrompt equals the base prompt.
 *   2. With skillIds, the project's skills.json is loaded and the
 *      compiled markdown is appended (without mutating ctx).
 *   3. skillValues fill in {{placeholders}} during compilation.
 *   4. Unknown skill IDs are silently dropped and surfaced in the tool
 *      result text.
 *   5. The minion_spawned event carries armedSkillIds.
 *   6. The spawn user-prompt structure: Description / Acceptance Criteria
 *      header, project-context pointer, no "execute now" trailer.
 *   7. The worktree branch is injected into the spawn prompt when set.
 *   8. The armed skill IDs are injected into the spawn prompt when armed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAssignTaskToolDef } from "./assign-task.ts";
import type {
  TaskManagerState,
  TaskToolContext,
} from "./types.ts";
import type { Bus, BusPayload } from "../bus.ts";
import { writeSettings, writeSkills } from "../project-store.ts";
import { saveWorkPacket } from "../system-model/store.ts";
import type { WorkPacket } from "../../shared/system-model/index.ts";

const BASE_MINION_PROMPT = "You are a Minion. Do the work.";

interface CapturedSpawn {
  sessionKey: string;
  prompt: string;
  cwd: string;
  systemPrompt: string;
  model?: string;
  harness?: string;
}

interface Harness {
  ctx: TaskToolContext;
  spawns: CapturedSpawn[];
  emissions: { sessionKey: string; payload: BusPayload }[];
  projectDir: string;
}

function makeHarness(projectDir: string): Harness {
  const spawns: CapturedSpawn[] = [];
  const emissions: { sessionKey: string; payload: BusPayload }[] = [];

  const bus: Bus = {
    emit: () => {},
    emitToSession: (sessionKey, payload) => {
      emissions.push({ sessionKey, payload });
    },
    emitToProject: () => {},
    emitGlobal: () => {},
    subscribe: () => () => {},
  };

  const taskState: TaskManagerState = {
    tasks: new Map(),
    pendingWait: null,
    approval: null,
  };

  const ctx: TaskToolContext = {
    leaderSessionKey: "leader-key",
    bus,
    startMinionSession: (params) => {
      spawns.push(params);
    },
    cwd: projectDir,
    projectPath: projectDir,
    minionSystemPrompt: BASE_MINION_PROMPT,
    taskState,
    scheduleWaitContinue: () => {},
  };

  return { ctx, spawns, emissions, projectDir };
}

async function callAssign(
  ctx: TaskToolContext,
  args: {
    taskId: string;
    title: string;
    description: string;
    priority: "low" | "medium" | "high" | "critical";
    executorClass?: "mechanical" | "standard" | "reasoning";
    model?: string;
    timeout_minutes?: number;
    ownedPaths?: string[];
    include_canvas_context?: boolean;
    skillIds?: string[];
    skillValues?: Record<string, Record<string, string>>;
    workPacketId?: string;
  },
): Promise<{ text: string }> {
  const tool = createAssignTaskToolDef(ctx);
  const result = (await tool.handler(args)) as { content: Array<{ type: string; text: string }> };
  const block = result.content[0];
  if (!block || block.type !== "text") {
    throw new Error("Expected text content block from assign_task");
  }
  return { text: block.text };
}

function lastSpawnPrompt(harness: Harness): string {
  const last = harness.spawns[harness.spawns.length - 1];
  if (!last) throw new Error("No spawn captured");
  return last.prompt;
}

describe("assign_task", () => {
  let projectDir: string;
  let harness: Harness;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "assign-task-test-"));
    harness = makeHarness(projectDir);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    // ownedPaths now lives on each task record in the per-test taskState Map,
    // which is recreated in beforeEach — no module-level registry to clear.
  });

  it("rejects garbage input before spawning a minion — parse guard", async () => {
    // Null and empty objects lack all required fields.
    await expect(callAssign(harness.ctx, null as never)).rejects.toThrow();
    // Wrong priority enum value.
    await expect(
      callAssign(harness.ctx, {
        taskId: "t",
        title: "T",
        description: "D",
        priority: "urgent" as never,
      }),
    ).rejects.toThrow();
    // Missing 'description'.
    await expect(
      callAssign(harness.ctx, {
        taskId: "t",
        title: "T",
        description: undefined as never,
        priority: "low",
      }),
    ).rejects.toThrow();

    expect(harness.spawns).toHaveLength(0);
  });

  it("uses the base minion prompt when no skillIds are provided", async () => {
    await callAssign(harness.ctx, {
      taskId: "t1",
      title: "Do thing",
      description: "details",
      priority: "medium",
    });

    expect(harness.spawns).toHaveLength(1);
    expect(harness.spawns[0]!.systemPrompt).toBe(BASE_MINION_PROMPT);
  });

  it("appends compiled skill markdown when skillIds are provided", async () => {
    writeSkills(projectDir, [
      {
        id: "lint",
        name: "Lint Cleanup",
        description: "Clean up lint",
        category: "code",
        icon: "🧹",
        accentColor: "#000",
        template: "Run the linter and fix every warning.",
        variables: [],
      },
    ]);

    await callAssign(harness.ctx, {
      taskId: "t2",
      title: "Lint",
      description: "details",
      priority: "low",
      skillIds: ["lint"],
    });

    const sent = harness.spawns[0]!.systemPrompt;
    expect(sent).toContain(BASE_MINION_PROMPT);
    expect(sent).toContain("# Active Skills");
    expect(sent).toContain("## Skill: Lint Cleanup");
    expect(sent).toContain("Run the linter and fix every warning.");
    expect(sent.startsWith(BASE_MINION_PROMPT)).toBe(true);
  });

  it("substitutes skillValues into {{placeholders}}", async () => {
    writeSkills(projectDir, [
      {
        id: "review",
        name: "Code Review",
        description: "Review code",
        category: "code",
        icon: "👀",
        accentColor: "#000",
        template: "Review the {{language}} code under {{path}}.",
        variables: [],
      },
    ]);

    await callAssign(harness.ctx, {
      taskId: "t3",
      title: "Review",
      description: "details",
      priority: "high",
      skillIds: ["review"],
      skillValues: { review: { language: "TypeScript", path: "src/" } },
    });

    const sent = harness.spawns[0]!.systemPrompt;
    expect(sent).toContain("Review the TypeScript code under src/.");
  });

  it("does not mutate ctx.minionSystemPrompt across calls", async () => {
    writeSkills(projectDir, [
      {
        id: "lint",
        name: "Lint",
        description: "",
        category: "code",
        icon: "🧹",
        accentColor: "#000",
        template: "Lint stuff",
        variables: [],
      },
    ]);

    await callAssign(harness.ctx, {
      taskId: "armed",
      title: "Armed",
      description: "x",
      priority: "low",
      skillIds: ["lint"],
    });

    await callAssign(harness.ctx, {
      taskId: "bare",
      title: "Bare",
      description: "x",
      priority: "low",
    });

    expect(harness.ctx.minionSystemPrompt).toBe(BASE_MINION_PROMPT);
    expect(harness.spawns[0]!.systemPrompt).toContain("Lint stuff");
    expect(harness.spawns[1]!.systemPrompt).toBe(BASE_MINION_PROMPT);
  });

  it("silently drops unknown skill IDs and notes them in the result text", async () => {
    writeSkills(projectDir, [
      {
        id: "real",
        name: "Real",
        description: "",
        category: "general",
        icon: "✨",
        accentColor: "#000",
        template: "Real instructions.",
        variables: [],
      },
    ]);

    const { text } = await callAssign(harness.ctx, {
      taskId: "t4",
      title: "Mixed",
      description: "x",
      priority: "low",
      skillIds: ["real", "ghost"],
    });

    const sent = harness.spawns[0]!.systemPrompt;
    expect(sent).toContain("Real instructions.");
    expect(sent).not.toContain("ghost");
    // Token-efficiency contract: only NEW information is returned. Dropped
    // IDs are reported (the drop is otherwise silent); armed skills are
    // derivable as requested-minus-dropped, so they are not echoed back.
    expect(text).toContain("Skipped unknown skill IDs: ghost");
    expect(text).not.toContain("Armed with skills");
  });

  it("emits minion_spawned with armedSkillIds", async () => {
    writeSkills(projectDir, [
      {
        id: "a",
        name: "Alpha",
        description: "",
        category: "general",
        icon: "✨",
        accentColor: "#000",
        template: "Alpha.",
        variables: [],
      },
      {
        id: "b",
        name: "Beta",
        description: "",
        category: "general",
        icon: "✨",
        accentColor: "#000",
        template: "Beta.",
        variables: [],
      },
    ]);

    await callAssign(harness.ctx, {
      taskId: "t5",
      title: "Two",
      description: "x",
      priority: "low",
      skillIds: ["a", "b"],
    });

    const spawned = harness.emissions.find(
      (e) => (e.payload as { type?: string }).type === "minion_spawned",
    );
    expect(spawned).toBeDefined();
    expect(
      (spawned!.payload as { skillIds?: string[] }).skillIds,
    ).toEqual(["a", "b"]);
  });

  // Note: an "emits minion_spawned with empty skillIds when none passed"
  // test was removed per testing-strategy.md §5.7 — it asserted the
  // default-empty array on a payload that's already round-tripped in the
  // skillIds happy-path case above.

  describe("spawn user-prompt structure", () => {
    it("uses the Description header and drops the legacy trailer", async () => {
      await callAssign(harness.ctx, {
        taskId: "t-struct",
        title: "Add a thing",
        description: "Add a button to LeaderNode that does X.",
        priority: "medium",
      });

      const prompt = lastSpawnPrompt(harness);
      expect(prompt).toContain("## Task Assignment");
      expect(prompt).toContain("**Task ID:** t-struct");
      expect(prompt).toContain("**Title:** Add a thing");
      expect(prompt).toContain("**Priority:** medium");
      expect(prompt).toContain("## Description");
      expect(prompt).toContain("Add a button to LeaderNode that does X.");
      expect(prompt).not.toContain("Please execute this task now.");
    });

    it("always includes the project-context pointer to CLAUDE.md", async () => {
      await callAssign(harness.ctx, {
        taskId: "t-ctx",
        title: "Anything",
        description: "details",
        priority: "low",
      });

      const prompt = lastSpawnPrompt(harness);
      expect(prompt).toContain("**Project context:**");
      expect(prompt).toContain("CLAUDE.md");
    });

    it("injects the worktree branch when ctx.worktreeBranch is set", async () => {
      harness.ctx.worktreeBranch = "claude/leader-key/feature-x";

      await callAssign(harness.ctx, {
        taskId: "t-branch",
        title: "Branch test",
        description: "details",
        priority: "low",
      });

      const prompt = lastSpawnPrompt(harness);
      expect(prompt).toContain("**Worktree branch:**");
      expect(prompt).toContain("claude/leader-key/feature-x");
    });

    // Note: an "omits the worktree branch line" negative-existence test
    // was removed per §5.9 — already covered by the positive case ("injects
    // the worktree branch when ctx.worktreeBranch is set"), which proves
    // the branch line is conditional on ctx.worktreeBranch.

    it("lists armed skill IDs in the spawn prompt when skills are attached", async () => {
      writeSkills(projectDir, [
        {
          id: "lint",
          name: "Lint",
          description: "",
          category: "code",
          icon: "🧹",
          accentColor: "#000",
          template: "Lint stuff",
          variables: [],
        },
        {
          id: "review",
          name: "Review",
          description: "",
          category: "code",
          icon: "👀",
          accentColor: "#000",
          template: "Review stuff",
          variables: [],
        },
      ]);

      await callAssign(harness.ctx, {
        taskId: "t-skills",
        title: "Armed",
        description: "details",
        priority: "low",
        skillIds: ["lint", "review"],
      });

      const prompt = lastSpawnPrompt(harness);
      expect(prompt).toContain("**Armed skills:** lint, review");
      expect(prompt).toContain('"Active Skills"');
    });

    // Note: an "omits the armed skills line" negative-existence test was
    // removed per §5.9 — already covered by the positive case above.

    it("injects connected canvas context by default when a snapshot is present", async () => {
      harness.ctx.getCanvasContext = () =>
        "<connected-context>\nThe following context has been provided by the user via connected canvas nodes:\n\n<context-group title=\"Spec\">\nBuild the compact view.\n</context-group>\n</connected-context>";

      await callAssign(harness.ctx, {
        taskId: "t-canvas",
        title: "Use canvas",
        description: "details",
        priority: "medium",
      });

      const prompt = lastSpawnPrompt(harness);
      expect(prompt).toContain("## Canvas context (from connected nodes)");
      expect(prompt).toContain("Build the compact view.");
    });

    it("omits canvas context when absent or explicitly disabled", async () => {
      harness.ctx.getCanvasContext = () => null;
      await callAssign(harness.ctx, {
        taskId: "t-canvas-absent",
        title: "No canvas",
        description: "details",
        priority: "low",
      });

      harness.ctx.getCanvasContext = () =>
        "<connected-context>\nThe following context has been provided by the user via connected canvas nodes:\n\n<context-group>\nHidden\n</context-group>\n</connected-context>";
      await callAssign(harness.ctx, {
        taskId: "t-canvas-off",
        title: "No canvas",
        description: "details",
        priority: "low",
        include_canvas_context: false,
      });

      expect(harness.spawns[0]!.prompt).not.toContain("## Canvas context");
      expect(harness.spawns[1]!.prompt).not.toContain("## Canvas context");
    });

    it("injects a stored Context Pack when workPacketId is supplied and system-model mode is active", async () => {
      fs.mkdirSync(path.join(projectDir, ".systemmodel"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, ".systemmodel/manifest.yaml"), "name: test\n");
      writeSettings(projectDir, { systemModel: "advisory" });
      saveWorkPacket(projectDir, packet, "Suggested files are hints, not truth.\nConstraint constraint.bus_only: use the bus", 100);

      await callAssign(harness.ctx, {
        taskId: "t-packet",
        title: "Use packet",
        description: "details",
        priority: "high",
        workPacketId: packet.id,
      });

      const prompt = lastSpawnPrompt(harness);
      expect(prompt).toContain("## System Model Context");
      expect(prompt).toContain("Constraint constraint.bus_only");
    });
  });

  // ── model override ────────────────────────────────────────────────────────

  it("passes explicit model arg to startMinionSession (takes precedence over defaults)", async () => {
    await callAssign(harness.ctx, {
      taskId: "t-model-explicit",
      title: "Explicit model",
      description: "details",
      priority: "low",
      model: "claude-haiku-4-5",
    });

    expect(harness.spawns[0]?.model).toBe("claude-haiku-4-5");
  });

  it("falls back to settings.defaultMinionModel when no model arg is provided", async () => {
    writeSettings(projectDir, { defaultMinionModel: "claude-test-minion" });

    await callAssign(harness.ctx, {
      taskId: "t-model-settings",
      title: "Settings model",
      description: "details",
      priority: "low",
    });

    expect(harness.spawns[0]?.model).toBe("claude-test-minion");
  });

  it("model arg overrides settings.defaultMinionModel", async () => {
    writeSettings(projectDir, { defaultMinionModel: "claude-test-minion" });

    await callAssign(harness.ctx, {
      taskId: "t-model-override",
      title: "Override model",
      description: "details",
      priority: "low",
      model: "claude-haiku-4-5",
    });

    expect(harness.spawns[0]?.model).toBe("claude-haiku-4-5");
  });

  it("explicit model arg wins over executorClass mapping", async () => {
    writeSettings(projectDir, {
      mechanicalMinionModel: "claude-mechanical",
      defaultMinionModel: "claude-standard",
    });

    await callAssign(harness.ctx, {
      taskId: "t-model-wins",
      title: "Exact model",
      description: "details",
      priority: "low",
      executorClass: "mechanical",
      model: "claude-explicit",
    });

    expect(harness.spawns[0]?.model).toBe("claude-explicit");
  });

  it("maps mechanical executorClass to a Codex-valid model under the Codex harness", async () => {
    writeSettings(projectDir, {
      defaultMinionHarness: "codex",
      defaultMinionModel: "gpt-5.5",
      mechanicalMinionModel: "claude-haiku-4-5",
    });

    await callAssign(harness.ctx, {
      taskId: "t-codex-mechanical",
      title: "Codex mechanical",
      description: "details",
      priority: "low",
      executorClass: "mechanical",
    });

    expect(harness.spawns[0]?.harness).toBe("codex");
    expect(harness.spawns[0]?.model).toBe("gpt-5.5");
    expect(harness.spawns[0]?.model).not.toBe("claude-haiku-4-5");
  });

  it.each([
    ["mechanical", "claude-mechanical"],
    ["standard", "claude-standard"],
    ["reasoning", "claude-reasoning"],
  ] as const)("maps executorClass %s to the configured tier model", async (executorClass, expected) => {
    writeSettings(projectDir, {
      defaultMinionModel: "claude-standard",
      mechanicalMinionModel: "claude-mechanical",
      reasoningMinionModel: "claude-reasoning",
    });

    await callAssign(harness.ctx, {
      taskId: `t-${executorClass}`,
      title: `${executorClass} tier`,
      description: "details",
      priority: "medium",
      executorClass,
    });

    expect(harness.spawns.at(-1)?.model).toBe(expected);
  });

  it("falls back to the existing default chain when executorClass is absent", async () => {
    writeSettings(projectDir, {
      defaultModel: "claude-base",
      defaultMinionModel: 123 as unknown as string,
      mechanicalMinionModel: "claude-mechanical",
      reasoningMinionModel: "claude-reasoning",
    });

    await callAssign(harness.ctx, {
      taskId: "t-no-class",
      title: "No class",
      description: "details",
      priority: "medium",
    });

    expect(harness.spawns[0]?.model).toBe("claude-base");
  });

  // ── timeout_minutes ───────────────────────────────────────────────────────

  it("timeout_minutes × 60_000 is passed to scheduleTaskTimeout (fires after custom ms)", async () => {
    vi.useFakeTimers();
    try {
      await callAssign(harness.ctx, {
        taskId: "t-timeout-custom",
        title: "Custom timeout",
        description: "details",
        priority: "low",
        timeout_minutes: 1,
      });

      // Immediately after assignment the task is in "starting" state.
      expect(harness.ctx.taskState.tasks.get("t-timeout-custom")?.status).toBe("starting");

      // Advance past the 1-minute (60_000 ms) custom timeout.
      vi.advanceTimersByTime(60_001);

      // The timeout event should have fired and moved the task to "failed".
      expect(harness.ctx.taskState.tasks.get("t-timeout-custom")?.status).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("default timeout does NOT fire after 60 seconds when timeout_minutes is omitted", async () => {
    vi.useFakeTimers();
    try {
      await callAssign(harness.ctx, {
        taskId: "t-timeout-default",
        title: "Default timeout",
        description: "details",
        priority: "low",
        // no timeout_minutes — defaults to 30 min (1_800_000 ms)
      });

      vi.advanceTimersByTime(60_001);

      // Should still be "starting" — the 30-minute default hasn't elapsed.
      expect(harness.ctx.taskState.tasks.get("t-timeout-default")?.status).toBe("starting");
    } finally {
      vi.useRealTimers();
    }
  });

  // ── ownedPaths ────────────────────────────────────────────────────────────

  it("appends a labeled Owned paths section to the spawn prompt when ownedPaths is provided", async () => {
    await callAssign(harness.ctx, {
      taskId: "t-paths-header",
      title: "Paths header",
      description: "details",
      priority: "low",
      ownedPaths: ["src/foo.ts", "src/bar.ts"],
    });

    const prompt = lastSpawnPrompt(harness);
    expect(prompt).toContain("## Owned paths (your write boundary)");
    expect(prompt).toContain("- src/foo.ts");
    expect(prompt).toContain("- src/bar.ts");
  });

  it("warns in the tool result when two concurrent tasks share an ownedPath", async () => {
    // Assign first task with ownedPaths — it transitions to "starting".
    await callAssign(harness.ctx, {
      taskId: "t-overlap-a",
      title: "Task A",
      description: "details",
      priority: "low",
      ownedPaths: ["src/foo.ts", "src/shared.ts"],
    });

    // Assign second task that overlaps on "src/shared.ts".
    const { text } = await callAssign(harness.ctx, {
      taskId: "t-overlap-b",
      title: "Task B",
      description: "details",
      priority: "low",
      ownedPaths: ["src/bar.ts", "src/shared.ts"],
    });

    expect(text).toContain("Warning: ownedPaths overlap with running task t-overlap-a: src/shared.ts");
  });

  it("does not warn when the other task is completed (not running/starting)", async () => {
    await callAssign(harness.ctx, {
      taskId: "t-done-path",
      title: "Done",
      description: "details",
      priority: "low",
      ownedPaths: ["src/shared.ts"],
    });

    // Simulate task completion so it is no longer active.
    const doneTask = harness.ctx.taskState.tasks.get("t-done-path")!;
    doneTask.status = "completed";
    doneTask.completedAt = Date.now();

    const { text } = await callAssign(harness.ctx, {
      taskId: "t-after-done",
      title: "After done",
      description: "details",
      priority: "low",
      ownedPaths: ["src/shared.ts"],
    });

    expect(text).not.toContain("Warning");
  });

  // ── retry ─────────────────────────────────────────────────────────────────

  it("allows re-assignment of a failed task, spawns a new minion, and mentions attempt 2", async () => {
    // Initial assignment
    await callAssign(harness.ctx, {
      taskId: "t-retry",
      title: "Retry me",
      description: "details",
      priority: "low",
    });
    expect(harness.spawns).toHaveLength(1);

    // Simulate failure
    const task = harness.ctx.taskState.tasks.get("t-retry")!;
    task.status = "failed";
    task.result = "Network timeout.";

    // Retry
    const { text } = await callAssign(harness.ctx, {
      taskId: "t-retry",
      title: "Retry me",
      description: "details",
      priority: "low",
    });

    expect(harness.spawns).toHaveLength(2);
    expect(text).toContain("attempt 2");
  });

  it("allows re-assignment of an orphaned task", async () => {
    await callAssign(harness.ctx, {
      taskId: "t-orphan",
      title: "Orphan",
      description: "details",
      priority: "low",
    });

    harness.ctx.taskState.tasks.get("t-orphan")!.status = "orphaned";

    const { text } = await callAssign(harness.ctx, {
      taskId: "t-orphan",
      title: "Orphan",
      description: "details",
      priority: "low",
    });

    expect(text).toContain("attempt 2");
    expect(harness.spawns).toHaveLength(2);
  });

  it("refuses a completed task with a create-new-task hint", async () => {
    await callAssign(harness.ctx, {
      taskId: "t-completed",
      title: "Completed",
      description: "details",
      priority: "low",
    });

    harness.ctx.taskState.tasks.get("t-completed")!.status = "completed";

    const { text } = await callAssign(harness.ctx, {
      taskId: "t-completed",
      title: "Completed",
      description: "details",
      priority: "low",
    });

    expect(text).toContain("already completed");
    expect(text).toContain("create a new task instead");
    // No second spawn
    expect(harness.spawns).toHaveLength(1);
  });
});

const packet: WorkPacket = {
  id: "wp_assign",
  leaderSessionKey: "leader-key",
  createdAt: 1,
  userRequest: "request",
  normalizedGoal: "request",
  status: "draft",
  scope: { capabilities: [], flows: [], constraints: [], decisions: [], risks: [], suggestedFiles: [], suggestedTests: [] },
  nonGoals: [],
  agentInstructions: [],
  freshness: { status: "fresh", warnings: [], requiredVerifications: [] },
  reviewGates: [],
  riskLevel: "low",
  matchConfidence: "high",
  amendments: [],
};
