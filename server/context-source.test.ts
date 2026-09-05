import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistContextSource } from "./context-source.ts";
import { registerWorkspace } from "./workspace-registry.ts";
import { truncateCanvasContext } from "./task-tools/task-prompt.ts";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("bounded context source retrieval", () => {
  it("retains a readable immutable full source behind an oversized excerpt", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-source-test-"));
    roots.push(root);
    const project = path.join(root, "project");
    fs.mkdirSync(project);
    vi.stubEnv("MINIONS_HOME", path.join(root, "state"));
    registerWorkspace(project);
    const content = `<context-group title="API">KEEP_V1 ${"x".repeat(7000)} FULL_MIDDLE_REQUIREMENT ${"x".repeat(7000)} END</context-group>`;
    const reference = persistContextSource(project, content)!;
    const excerpt = truncateCanvasContext(content, 6000, reference);
    expect(excerpt.length).toBeLessThanOrEqual(6000);
    expect(excerpt).toContain(reference);
    expect(excerpt).toContain("KEEP_V1");
    expect(excerpt).not.toContain("FULL_MIDDLE_REQUIREMENT");
    expect(fs.readFileSync(reference, "utf8")).toBe(content);
    expect(persistContextSource(project, content)).toBe(reference);
    fs.writeFileSync(reference, "tampered");
    expect(() => persistContextSource(project, content)).toThrow("integrity mismatch");
  });
});
