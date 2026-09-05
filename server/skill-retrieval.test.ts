import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeSkills } from "./project-store.ts";
import { compileSkills, type SkillTemplate } from "./skills.ts";
import { captureSkillSnapshot, readSkillSnapshot } from "./skill-snapshot.ts";
import { createSkillRetrievalTools, SKILL_ATTACHMENT_PAGE_CHARS } from "./skill-retrieval.ts";

function disclosureFixture(): SkillTemplate {
  return { id: "design", name: "Design", description: "Design things", category: "design",
    icon: "*", accentColor: "#fff", template: "PARENT {{target}}",
    variables: [{ name: "target", label: "Target", type: "text", defaultValue: "default target" }],
    attachments: [{ kind: "text", filename: "reference.md", mediaType: "text/markdown",
      text: "PARENT_ATTACHMENT".repeat(2000), truncated: false }],
    subskills: [
      { id: "eager", name: "Eager", description: "Always needed", body: "EAGER_BODY", alwaysInclude: true },
      { id: "lazy", name: "Lazy", description: "Only sometimes", whenToUse: "When arranging panels", body: "LAZY_BODY",
        attachments: [{ kind: "text", filename: "layout.txt", mediaType: "text/plain", text: "SUB_ATTACHMENT", truncated: true }] },
    ] };
}

describe("progressive skill retrieval", () => {
  let root: string;
  let projectPath: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-retrieval-"));
    projectPath = path.join(root, "project"); fs.mkdirSync(projectPath);
    vi.stubEnv("MINIONS_HOME", path.join(root, "state"));
    writeSkills(projectPath, [disclosureFixture()]);
  });
  afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

  function toolsFor(skillSnapshotId = captureSkillSnapshot(projectPath, { design: { target: "dashboard" } })) {
    const defs = createSkillRetrievalTools({ projectPath, skillSnapshotId });
    return { skillSnapshotId, names: defs.map(def => def.name),
      call: async (name: string, input: unknown) => {
        const result = await defs.find(def => def.name === name)!.handler(input) as { content: { text: string }[] };
        return result.content[0]!.text;
      } };
  }

  it("loads parent instructions and triggers without authoring permissions or lazy contents", async () => {
    const tools = toolsFor();
    expect(tools.names).toEqual(["load_skill", "load_subskill", "load_skill_attachment"]);
    const parent = await tools.call("load_skill", { skillId: "design" });
    for (const text of ["PARENT dashboard", "EAGER_BODY", "When arranging panels", "load_skill_attachment", "reference.md"]) expect(parent).toContain(text);
    for (const text of ["LAZY_BODY", "PARENT_ATTACHMENT", "SUB_ATTACHMENT"]) expect(parent).not.toContain(text);
    expect(await tools.call("load_skill", { skillId: "design", values: { target: "mobile" } })).toContain("PARENT mobile");
  });

  it("keeps prompts and later retrieval on the same snapshot after edits, deletion and tool reconstruction", async () => {
    const tools = toolsFor();
    const changed = disclosureFixture(); changed.template = "CHANGED_PARENT"; changed.subskills![1]!.body = "CHANGED_SUB";
    writeSkills(projectPath, [changed]);
    const restored = toolsFor(tools.skillSnapshotId);
    writeSkills(projectPath, []);
    expect(await restored.call("load_skill", { skillId: "design" })).toContain("PARENT dashboard");
    expect(await restored.call("load_subskill", { skillId: "design", subskillId: "lazy" })).toContain("LAZY_BODY");
    const frozen = readSkillSnapshot(projectPath, tools.skillSnapshotId);
    expect(compileSkills(frozen.skills.filter(skill => skill.id === "design"), frozen.values)).toContain("PARENT dashboard");
    expect(await restored.call("load_subskill", { skillId: "design", subskillId: "missing" })).toContain("Valid sub-skill ids");
  });

  it("pages one attachment without omission or sibling content and reports truncated sources", async () => {
    const tools = toolsFor(); let offset: number | null = 0; let text = "";
    while (offset !== null) {
      const page = JSON.parse(await tools.call("load_skill_attachment", { skillId: "design", attachmentIndex: 0, offset }));
      expect(page.text.length).toBeLessThanOrEqual(SKILL_ATTACHMENT_PAGE_CHARS);
      expect(page.text).not.toContain("SUB_ATTACHMENT");
      text += page.text; offset = page.nextOffset;
    }
    expect(text).toBe(disclosureFixture().attachments![0]!.text);
    const sub = JSON.parse(await tools.call("load_skill_attachment", { skillId: "design", subskillId: "lazy", attachmentIndex: 0 }));
    expect(sub).toMatchObject({ text: "SUB_ATTACHMENT", sourceTruncated: true, nextOffset: null });
    expect(await tools.call("load_skill_attachment", { skillId: "design", attachmentIndex: 3 })).toContain("Unknown attachment index");
    await expect(tools.call("load_skill_attachment", { skillId: "design", attachmentIndex: 0, offset: -1 })).rejects.toThrow();
  });

  it("rejects missing, tampered or path-like snapshots instead of falling back to live definitions", () => {
    const tools = toolsFor();
    expect(() => toolsFor("../skills")).toThrow("Invalid skill snapshot ID");
    expect(() => toolsFor("f".repeat(64))).toThrow();
    const file = fs.readdirSync(path.join(root, "state", "workspaces"), { recursive: true })
      .map(String).find(name => name.endsWith(`${tools.skillSnapshotId}.json`))!;
    fs.writeFileSync(path.join(root, "state", "workspaces", file), "{}");
    expect(() => toolsFor(tools.skillSnapshotId)).toThrow("integrity verification");
  });
});
