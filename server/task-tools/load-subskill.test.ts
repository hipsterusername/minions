/**
 * load_subskill (leader surface) — resolves a sub-skill body against the
 * leader's projectPath; tolerant of unknown ids (never throws / isError).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLoadSubskillToolDef } from "./load-subskill.ts";
import type { TaskToolContext } from "./types.ts";
import { writeSkills } from "../project-store.ts";

function makeCtx(projectPath: string): TaskToolContext {
  return {
    leaderSessionKey: "leader-1",
    // Bus is unused by this handler; a minimal stub keeps the test focused.
    bus: {} as TaskToolContext["bus"],
    startMinionSession: () => {},
    cwd: projectPath,
    projectPath,
    minionSystemPrompt: "",
    taskState: { tasks: new Map(), pendingWait: null, approval: null },
    scheduleWaitContinue: () => {},
  };
}

async function call(projectPath: string, args: unknown): Promise<string> {
  const def = createLoadSubskillToolDef(makeCtx(projectPath));
  const res = (await def.handler(args)) as {
    content: { type: "text"; text: string }[];
    isError?: boolean;
  };
  // Tolerant by contract: even a miss is a normal (non-error) text result.
  expect(res.isError).toBeFalsy();
  return res.content[0]!.text;
}

describe("load_subskill (leader)", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "load-subskill-"));
    writeSkills(projectDir, [
      {
        id: "design",
        name: "Design",
        description: "d",
        category: "design",
        icon: "🎨",
        accentColor: "#fff",
        template: "base",
        variables: [],
        subskills: [
          {
            id: "layout",
            name: "Layout",
            description: "layout rules",
            body: "LAYOUT BODY",
          },
        ],
      },
    ]);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("returns the body framed with a heading on valid ids", async () => {
    const text = await call(projectDir, {
      skillId: "design",
      subskillId: "layout",
    });
    expect(text).toBe("# Sub-skill: Design › Layout\n\nLAYOUT BODY");
  });

  it("tolerantly reports an unknown sub-skill without throwing", async () => {
    const text = await call(projectDir, {
      skillId: "design",
      subskillId: "ghost",
    });
    expect(text).toContain("ghost");
    expect(text).toContain("`layout`");
  });

  it("tolerantly reports an unknown skill", async () => {
    const text = await call(projectDir, {
      skillId: "nope",
      subskillId: "x",
    });
    expect(text).toContain("nope");
  });
});
