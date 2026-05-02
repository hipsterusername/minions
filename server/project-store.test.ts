/**
 * server/project-store — sidecar + per-project file accessors.
 *
 * IMPORTANT: `project-store.ts` captures `os.homedir()` at MODULE LOAD time
 * (`const GLOBAL_DIR = path.join(os.homedir(), ".minions")`). Tests
 * MUST mock `node:os` BEFORE importing project-store so the recent-projects
 * file lands in a tmpdir, not in the user's real home. The `vi.mock`
 * factory below uses a synchronous tmpdir creation so the mocked
 * `homedir()` is stable from the first import.
 *
 * Per docs/testing-strategy.md §5.4 we drive the real public API; per §5.7
 * we don't assert on internal file shapes beyond what the helpers expose.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// vi.mock factories are hoisted ABOVE imports, which means they run before
// any `import { mkdtempSync }` resolves. To avoid the TDZ trap, derive the
// tmpdir path deterministically from the PID inside `vi.hoisted` (which
// executes alongside the mock factory) and create the directory itself in
// `beforeAll`. The pid-based name is unique per vitest worker.
const { FAKE_HOME } = vi.hoisted(() => ({
  FAKE_HOME: `/tmp/minions-fakehome-${process.pid}`,
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: { ...actual, homedir: () => FAKE_HOME },
    homedir: () => FAKE_HOME,
  };
});

import {
  addRecentProject,
  hasSidecar,
  initSidecar,
  listRecentProjects,
  migrateGlobalDir,
  migrateSidecar,
  openProjectDb,
  readContext,
  readMcpServers,
  readSettings,
  readSkills,
  removeRecentProject,
  writeContext,
  writeMcpServers,
  writeSettings,
  writeSkills,
} from "./project-store.ts";

let project: string;
const cleanup: (() => void)[] = [];

beforeAll(() => {
  // Materialise the FAKE_HOME directory we promised the mocked os.homedir().
  mkdirSync(FAKE_HOME, { recursive: true });
});

afterAll(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "minions-project-"));
  cleanup.push(() => rmSync(project, { recursive: true, force: true }));
});

afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
  // Reset the recent-projects.json between tests so they're independent.
  rmSync(join(FAKE_HOME, ".minions", "recent-projects.json"), {
    force: true,
  });
});

describe("initSidecar / openProjectDb", () => {
  it("creates the sidecar directory, default context.md, and settings.json", () => {
    expect(hasSidecar(project)).toBe(false);
    initSidecar(project);
    expect(hasSidecar(project)).toBe(true);

    const ctx = readContext(project);
    expect(ctx.exists).toBe(true);
    // Don't pin the literal copy (§5.7) — assert structure: a heading +
    // at least one paragraph.
    expect(ctx.content.trim().startsWith("#")).toBe(true);
    expect(
      ctx.content.split("\n").filter((l) => l.trim().length > 0).length,
    ).toBeGreaterThanOrEqual(2);

    const settings = readSettings(project);
    expect(settings.defaultModel).toBeTruthy();
    expect(settings.defaultPermissionMode).toBeTruthy();
    expect(typeof settings.defaultWorktreeIsolation).toBe("boolean");
  });

  it("openProjectDb initialises a fresh project and re-uses an existing sidecar", () => {
    expect(hasSidecar(project)).toBe(false);
    const db1 = openProjectDb(project);
    expect(hasSidecar(project)).toBe(true);
    db1.close();

    const db1b = openProjectDb(project);
    db1b
      .prepare("INSERT INTO projects (id, name) VALUES (?, ?)")
      .run("p1", "First");
    db1b.close();

    const db2 = openProjectDb(project);
    const row = db2
      .prepare("SELECT name FROM projects WHERE id = ?")
      .get("p1");
    expect(row).toMatchObject({ name: "First" });
    db2.close();
  });
});

describe("context / settings / skills / mcp-servers round-trip", () => {
  beforeEach(() => {
    initSidecar(project);
  });

  it("readContext returns the default for a missing file (does not throw)", () => {
    rmSync(join(project, ".minions", "context.md"));
    const ctx = readContext(project);
    expect(ctx).toEqual({ content: "", exists: false });
  });

  it("writeContext / readContext round-trip preserves the markdown bytes", () => {
    const md = "# Project\n\nSome **bold** text and a `code` span.\n";
    writeContext(project, md);
    expect(readContext(project)).toEqual({ content: md, exists: true });
  });

  it("writeSettings / readSettings round-trip", () => {
    const next = {
      defaultModel: "opus",
      defaultPermissionMode: "review",
      defaultWorktreeIsolation: true,
      customExtra: 42,
    };
    writeSettings(project, next);
    expect(readSettings(project)).toEqual(next);
  });

  it("readSkills returns [] for an unwritten skills file and round-trips after write", () => {
    expect(readSkills(project)).toEqual([]);
    const skills = [{ id: "alpha" }, { id: "beta", body: "rules" }];
    writeSkills(project, skills);
    expect(readSkills(project)).toEqual(skills);
  });

  it("readMcpServers returns [] for an unwritten file and round-trips after write", () => {
    expect(readMcpServers(project)).toEqual([]);
    const servers = [
      { id: "ex", transport: "stdio", command: "node" },
      { id: "ex2", transport: "sse", url: "https://x" },
    ];
    writeMcpServers(project, servers);
    expect(readMcpServers(project)).toEqual(servers);
  });
});

describe("recent-projects index", () => {
  it("starts empty and round-trips through add/list", () => {
    expect(listRecentProjects()).toEqual([]);
    addRecentProject("/projects/alpha", "Alpha");
    addRecentProject("/projects/beta", "Beta");
    const recent = listRecentProjects();
    // Most-recent-first.
    expect(recent.map((r) => r.path)).toEqual([
      "/projects/beta",
      "/projects/alpha",
    ]);
    expect(recent[0]!.lastOpened).toBeTruthy();
  });

  it("adding the same path twice dedupes and bumps it to the top", () => {
    addRecentProject("/projects/a", "A");
    addRecentProject("/projects/b", "B");
    addRecentProject("/projects/a", "A2");

    const recent = listRecentProjects();
    expect(recent.map((r) => r.path)).toEqual([
      "/projects/a",
      "/projects/b",
    ]);
    expect(recent[0]!.name).toBe("A2");
  });

  it("removeRecentProject filters by path", () => {
    addRecentProject("/projects/a", "A");
    addRecentProject("/projects/b", "B");
    removeRecentProject("/projects/a");
    expect(listRecentProjects().map((r) => r.path)).toEqual([
      "/projects/b",
    ]);
  });

  it("caps the recent list at 20 entries", () => {
    for (let i = 0; i < 25; i++) {
      addRecentProject(`/projects/p${i}`, `P${i}`);
    }
    const recent = listRecentProjects();
    expect(recent).toHaveLength(20);
    expect(recent[0]!.path).toBe("/projects/p24");
    expect(recent.at(-1)!.path).toBe("/projects/p5");
  });
});

// ── Migration tests ────────────────────────────────────────────────────────

describe("migrateSidecar", () => {
  it("renames .claude-canvas → .minions when only the old sidecar exists", () => {
    const oldSidecar = join(project, ".claude-canvas");
    const newSidecar = join(project, ".minions");
    mkdirSync(join(oldSidecar, "routines"), { recursive: true });
    writeFileSync(join(oldSidecar, "skills.json"), "[]");

    expect(existsSync(oldSidecar)).toBe(true);
    expect(existsSync(newSidecar)).toBe(false);

    migrateSidecar(project);

    expect(existsSync(oldSidecar)).toBe(false);
    expect(existsSync(newSidecar)).toBe(true);
    expect(existsSync(join(newSidecar, "skills.json"))).toBe(true);
  });

  it("is a no-op when .claude-canvas does not exist", () => {
    const newSidecar = join(project, ".minions");
    expect(existsSync(join(project, ".claude-canvas"))).toBe(false);

    migrateSidecar(project);

    expect(existsSync(newSidecar)).toBe(false);
  });

  it("is idempotent — calling again after migration completes is a no-op", () => {
    const oldSidecar = join(project, ".claude-canvas");
    mkdirSync(oldSidecar, { recursive: true });

    migrateSidecar(project); // first call: renames
    expect(existsSync(oldSidecar)).toBe(false);
    expect(existsSync(join(project, ".minions"))).toBe(true);

    migrateSidecar(project); // second call: no-op (old dir gone)
    expect(existsSync(join(project, ".minions"))).toBe(true);
  });

  it("leaves both directories intact when .minions already exists", () => {
    const oldSidecar = join(project, ".claude-canvas");
    const newSidecar = join(project, ".minions");
    mkdirSync(oldSidecar, { recursive: true });
    mkdirSync(newSidecar, { recursive: true });

    migrateSidecar(project);

    // Both still present — migration warns and bails
    expect(existsSync(oldSidecar)).toBe(true);
    expect(existsSync(newSidecar)).toBe(true);
  });
});

describe("migrateGlobalDir", () => {
  it("renames ~/.claude-canvas → ~/.minions when only the old dir exists", () => {
    const oldDir = join(FAKE_HOME, ".claude-canvas");
    const newDir = join(FAKE_HOME, ".minions");
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, "recent-projects.json"), "[]");
    rmSync(newDir, { recursive: true, force: true });

    migrateGlobalDir();

    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(newDir)).toBe(true);
    expect(existsSync(join(newDir, "recent-projects.json"))).toBe(true);
  });

  it("is a no-op when ~/.claude-canvas does not exist", () => {
    const oldDir = join(FAKE_HOME, ".claude-canvas");
    rmSync(oldDir, { recursive: true, force: true });

    migrateGlobalDir(); // should not throw

    expect(existsSync(oldDir)).toBe(false);
  });

  it("leaves both directories intact when ~/.minions already exists", () => {
    const oldDir = join(FAKE_HOME, ".claude-canvas");
    const newDir = join(FAKE_HOME, ".minions");
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });

    migrateGlobalDir();

    expect(existsSync(oldDir)).toBe(true);
    expect(existsSync(newDir)).toBe(true);
  });
});
