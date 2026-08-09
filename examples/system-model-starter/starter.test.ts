import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadSystemModel } from "../../server/system-model/load.ts";
import { validateLoadedSystemModel } from "../../server/system-model/validate.ts";

const starterDir = path.dirname(fileURLToPath(import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("system-model starter", () => {
  it("loads and validates without errors", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "system-model-starter-"));
    temporaryRoots.push(root);
    fs.cpSync(starterDir, path.join(root, ".systemmodel"), { recursive: true });

    const loaded = loadSystemModel(root);

    expect(loaded.errors).toEqual([]);
    expect(loaded.model).not.toBeNull();
    expect(validateLoadedSystemModel(loaded.model!)).toEqual([]);
    expect(loaded.model?.capabilities).toHaveLength(1);
    expect(loaded.model?.domains.map((domain) => domain.id)).toEqual(["domain.workspace"]);
    expect(loaded.model?.flows).toHaveLength(2);
    expect(loaded.model?.surfaces).toHaveLength(2);
    expect(loaded.model?.capabilities[0]?.entryPoints).toEqual([
      expect.objectContaining({ surface: "surface.canvas", flows: ["flow.open_workspace"] }),
      expect.objectContaining({ surface: "surface.mobile", flows: ["flow.save_workspace"] }),
    ]);
    expect(loaded.model?.constraints).toHaveLength(1);
    expect(loaded.model?.constraints[0]?.appliesTo.surfaces).toEqual([
      "surface.canvas", "surface.mobile",
    ]);
    expect(loaded.model?.policies.reviewGates).toHaveLength(1);
  });
});
