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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAssignTaskToolDef } from "./assign-task.ts";
import type {
  TaskManagerState,
  TaskToolContext,
} from "./types.ts";
import type { Bus, BusPayload } from "../bus.ts";
import { writeSkills } from "../project-store.ts";

const BASE_MINION_PROMPT = "You are a Minion. Do the work.";

interface CapturedSpawn {
  sessionKey: string;
  prompt: string;
  cwd: string;
  systemPrompt: string;
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
    skillIds?: string[];
    skillValues?: Record<string, Record<string, string>>;
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
    expect(text).toContain("Armed with skills: real");
    expect(text).toContain("Skipped unknown skill IDs: ghost");
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
    it("uses the Description / Acceptance Criteria header and drops the legacy trailer", async () => {
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
      expect(prompt).toContain("## Description / Acceptance Criteria");
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
  });
});
