/** Content-addressed skill catalogs. Prompt assembly and retrieval share the same bytes. */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { findWorkspaceBySource, registerWorkspace } from "./workspace-registry.ts";
import { loadAllSkills, type SkillTemplate } from "./skills.ts";

export interface SkillSnapshot {
  version: 1;
  skills: SkillTemplate[];
  values: Record<string, Record<string, string>>;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function snapshotPath(projectPath: string, id: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid skill snapshot ID");
  const workspace = findWorkspaceBySource(projectPath) ?? registerWorkspace(projectPath);
  if (!workspace) throw new Error("Skill snapshots require a registered workspace");
  return path.join(workspace.stateRoot, "skill-snapshots", `${id}.json`);
}

export function saveSkillSnapshot(projectPath: string, snapshot: SkillSnapshot): string {
  const text = JSON.stringify(snapshot);
  const id = digest(text);
  const filename = snapshotPath(projectPath, id);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  if (!fs.existsSync(filename)) {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, filename);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  return id;
}

export function captureSkillSnapshot(projectPath: string,
  values: SkillSnapshot["values"] = {}): string {
  return saveSkillSnapshot(projectPath, { version: 1, skills: loadAllSkills(projectPath), values });
}

/** A missing or changed snapshot fails explicitly; never silently read the live library. */
export function readSkillSnapshot(projectPath: string, id: string): SkillSnapshot {
  const text = fs.readFileSync(snapshotPath(projectPath, id), "utf8");
  if (digest(text) !== id) throw new Error(`Skill snapshot ${id} failed integrity verification`);
  const snapshot = JSON.parse(text) as SkillSnapshot;
  if (snapshot.version !== 1 || !Array.isArray(snapshot.skills) || !snapshot.values) {
    throw new Error(`Unsupported skill snapshot ${id}`);
  }
  return snapshot;
}

export function selectSnapshotSkills(snapshot: SkillSnapshot, ids: readonly string[]): SkillTemplate[] {
  const byId = new Map(snapshot.skills.map(skill => [skill.id, skill]));
  return [...new Set(ids)].flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
}
