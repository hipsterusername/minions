/**
 * Tests for the skill-authoring MCP tools (list/get/create/update/delete).
 * These exercise the tool handlers end-to-end against a real temp sidecar.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSkillAuthoringTools } from "./skill-authoring-tools.ts";
import { readSkills } from "./project-store.ts";
import type { NormalizedToolDef } from "./harness/types.ts";

function textOf(result: Awaited<ReturnType<NormalizedToolDef["handler"]>>): string {
  return result.content.map((b) => ("text" in b ? b.text : "")).join("");
}

describe("createSkillAuthoringTools", () => {
  let projectDir: string;
  let tools: Record<string, NormalizedToolDef>;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-authoring-"));
    tools = Object.fromEntries(
      createSkillAuthoringTools({ projectPath: projectDir }).map((t) => [t.name, t]),
    );
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("exposes the five authoring tools", () => {
    expect(Object.keys(tools).sort()).toEqual([
      "create_skill",
      "delete_skill",
      "get_skill",
      "list_skills",
      "update_skill",
    ]);
  });

  it("list_skills includes built-ins on an empty project", async () => {
    const res = await tools["list_skills"]!.handler({});
    const parsed = JSON.parse(textOf(res)) as Array<{ id: string; source: string }>;
    expect(parsed.some((s) => s.id === "skill-builder" && s.source === "built-in")).toBe(true);
  });

  it("create_skill persists a new skill and derives an id", async () => {
    const res = await tools["create_skill"]!.handler({
      name: "API Contract Reviewer",
      template: "Review the contract at {{path}}.",
      description: "Reviews API contracts",
      category: "code",
    });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("api-contract-reviewer");

    const saved = readSkills(projectDir);
    expect(saved).toHaveLength(1);
    const skill = saved[0] as { id: string; variables: unknown[] };
    expect(skill.id).toBe("api-contract-reviewer");
    // {{path}} was implicit → auto-declared as a variable
    expect(skill.variables).toHaveLength(1);
  });

  it("create_skill rejects a duplicate project id", async () => {
    await tools["create_skill"]!.handler({ name: "Dup", template: "b" });
    const res = await tools["create_skill"]!.handler({ name: "Dup", template: "b2" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("already exists");
  });

  it("create_skill validates required fields", async () => {
    const res = await tools["create_skill"]!.handler({ name: "X", template: "  " });
    expect(res.isError).toBe(true);
  });

  it("get_skill returns the full body for a built-in", async () => {
    const res = await tools["get_skill"]!.handler({ id: "skill-builder" });
    const parsed = JSON.parse(textOf(res)) as { id: string; template: string };
    expect(parsed.id).toBe("skill-builder");
    expect(parsed.template.length).toBeGreaterThan(0);
  });

  it("get_skill errors on an unknown id", async () => {
    const res = await tools["get_skill"]!.handler({ id: "nope" });
    expect(res.isError).toBe(true);
  });

  it("update_skill patches an existing skill, preserving unspecified fields", async () => {
    await tools["create_skill"]!.handler({
      name: "Doc Writer",
      template: "Write docs.",
      description: "orig",
    });
    const res = await tools["update_skill"]!.handler({
      id: "doc-writer",
      description: "revised",
    });
    expect(res.isError).toBeFalsy();
    const skill = readSkills(projectDir)[0] as { description: string; template: string };
    expect(skill.description).toBe("revised");
    expect(skill.template).toBe("Write docs.");
  });

  it("update_skill on a built-in writes a project override", async () => {
    const res = await tools["update_skill"]!.handler({
      id: "skill-builder",
      description: "my override",
    });
    expect(res.isError).toBeFalsy();
    const saved = readSkills(projectDir) as Array<{ id: string; description: string }>;
    const override = saved.find((s) => s.id === "skill-builder");
    expect(override?.description).toBe("my override");
  });

  it("update_skill errors on an unknown id", async () => {
    const res = await tools["update_skill"]!.handler({ id: "ghost" });
    expect(res.isError).toBe(true);
  });

  it("delete_skill removes a project skill", async () => {
    await tools["create_skill"]!.handler({ name: "Temp", template: "b" });
    const res = await tools["delete_skill"]!.handler({ id: "temp" });
    expect(res.isError).toBeFalsy();
    expect(readSkills(projectDir)).toHaveLength(0);
  });

  it("delete_skill refuses to delete a non-project (built-in) id", async () => {
    const res = await tools["delete_skill"]!.handler({ id: "skill-builder" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("not");
  });
});
