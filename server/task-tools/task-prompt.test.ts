import { describe, expect, it } from "vitest";
import {
  CANVAS_CONTEXT_TRUNCATED_MARKER,
  buildTaskSpawnPrompt,
  truncateCanvasContext,
} from "./task-prompt.ts";

function contextBlock(groups: string[]): string {
  return `<connected-context>\nThe following context has been provided by the user via connected canvas nodes:\n\n${groups.join("\n")}\n</connected-context>`;
}

describe("buildTaskSpawnPrompt canvas context", () => {
  it("injects system-model context before the task description", () => {
    const prompt = buildTaskSpawnPrompt({
      taskId: "t1",
      title: "Use packet",
      priority: "high",
      description: "details",
      armedSkillIds: [],
      contextPack: [
        "Suggested files are hints, not truth.",
        "Freshness instruction: inspect current code before editing.",
      ].join("\n"),
    });

    expect(prompt).toContain("## System Model Context");
    expect(prompt.indexOf("## System Model Context")).toBeLessThan(prompt.indexOf("## Description"));
    expect(prompt).toContain("Suggested files are hints, not truth.");
    expect(prompt).toContain("Freshness instruction: inspect current code before editing.");
  });

  it("appends the labeled canvas context section", () => {
    const prompt = buildTaskSpawnPrompt({
      taskId: "t1",
      title: "Use note",
      priority: "high",
      description: "details",
      armedSkillIds: [],
      canvasContext: contextBlock([
        "<context-group title=\"Note\">\nRemember the API shape.\n</context-group>",
      ]),
    });

    expect(prompt).toContain("## Canvas context (from connected nodes)");
    expect(prompt).toContain("Remember the API shape.");
  });

  it("truncates at whole trailing context groups and appends the marker", () => {
    const first = `<context-group title="First">\n${"a".repeat(1200)}\n</context-group>`;
    const second = `<context-group title="Second">\n${"b".repeat(1200)}\n</context-group>`;
    const third = `<context-group title="Third">\n${"c".repeat(1200)}\n</context-group>`;

    const truncated = truncateCanvasContext(
      contextBlock([first, second, third]),
      2800,
    );

    expect(truncated.length).toBeLessThanOrEqual(2800);
    expect(truncated).toContain("First");
    expect(truncated).toContain("Second");
    expect(truncated).not.toContain("Third");
    expect(truncated).toContain(CANVAS_CONTEXT_TRUNCATED_MARKER);
    expect(truncated).not.toContain("cccccccccc");
  });
});

describe("buildTaskSpawnPrompt worktree policy", () => {
  it("uses the shared-worktree minion policy without commit guidance", () => {
    const prompt = buildTaskSpawnPrompt({
      taskId: "t1",
      title: "Shared work",
      priority: "high",
      description: "details",
      armedSkillIds: [],
      worktreeBranch: "minions/leader/shared",
    });

    expect(prompt).toContain("Leader's shared worktree");
    expect(prompt).toContain("assigned files");
    expect(prompt).toMatch(/do not run `git commit`/i);
    expect(prompt).toContain("orchestrator owns");
    expect(prompt).not.toMatch(/commit your work|git add -A/i);
  });
});
