import fs from "node:fs";
import path from "node:path";

const fixtures = path.resolve(process.cwd(), "tests/fixtures/system-model");
// setup-node.ts owns this per-file root and removes it after the suite, even
// when a test fails. Capture it before individual fixtures change MINIONS_HOME.
const configuredTestHome = process.env["MINIONS_HOME"];
if (!configuredTestHome) throw new Error("System-model fixtures require tests/setup-node.ts");
const testHome = configuredTestHome;

export function copyValidFixture(): string {
  const dir = fs.mkdtempSync(path.join(testHome, "system-model-"));
  process.env["MINIONS_HOME"] = fs.mkdtempSync(path.join(testHome, "system-model-home-"));
  fs.cpSync(path.join(fixtures, "valid"), dir, { recursive: true });
  return dir;
}

export function copyValidFixtureWithSurfaces(): string {
  const dir = copyValidFixture();
  const root = path.join(dir, ".systemmodel");
  fs.mkdirSync(path.join(root, "surfaces"));
  fs.writeFileSync(path.join(root, "surfaces/canvas.yaml"), surfaceYaml("canvas", "src/Canvas.tsx"));
  fs.writeFileSync(path.join(root, "surfaces/mobile.yaml"), surfaceYaml("mobile", "src/mobile/**"));
  fs.appendFileSync(path.join(root, "capabilities/workspace.yaml"), `\nentry_points:\n  - surface: surface.canvas\n    summary: Canvas approval\n    files:\n      - src/Canvas.tsx\n    tests:\n      - src/Canvas.test.tsx\n    flows:\n      - flow.approve_changes\n  - surface: surface.mobile\n    files: [src/mobile/**]\n    tests: [src/mobile/app.test.ts]\n    flows: [flow.approve_changes]\n`);
  return dir;
}

function surfaceYaml(id: string, file: string): string {
  return `id: surface.${id}\ntype: surface\nname: ${id}\nsummary: ${id} surface\nkeywords: [${id}]\nsuggested_files: [${file}]\n`;
}
