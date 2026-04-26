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
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAssignTaskTool } from "./assign-task.ts";
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
  const tool = createAssignTaskTool(ctx);
  const result = await tool.handler(args as never, {});
  const block = result.content[0];
  if (!block || block.type !== "text") {
    throw new Error("Expected text content block from assign_task");
  }
  return { text: block.text };
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

  it("emits minion_spawned with empty skillIds when none are passed", async () => {
    await callAssign(harness.ctx, {
      taskId: "t6",
      title: "None",
      description: "x",
      priority: "low",
    });

    const spawned = harness.emissions.find(
      (e) => (e.payload as { type?: string }).type === "minion_spawned",
    );
    expect(
      (spawned!.payload as { skillIds?: string[] }).skillIds,
    ).toEqual([]);
  });
});
