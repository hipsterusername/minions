/**
 * server/project-store — sidecar + per-project file accessors.
 *
 * IMPORTANT: `project-store.ts` captures `os.homedir()` at MODULE LOAD time
 * (`const GLOBAL_DIR = path.join(os.homedir(), ".minions")`). Tests
 * MUST mock `node:os` BEFORE importing project-store so the recent-projects
 * file lands in a tmpdir, not in the user's real home. The `vi.mock`
 * factory below uses a synchronous tmpdir creation so the mocked
 * `homedir()` is stable from the first import.
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
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// vi.mock factories are hoisted ABOVE imports, which means they run before
// any `import { mkdtempSync }` resolves. To avoid the TDZ trap, derive the
// tmpdir path deterministically from the PID inside `vi.hoisted` (which
// executes alongside the mock factory) and create the directory itself in
// `beforeAll`. The pid-based name is unique per vitest worker.
const { FAKE_HOME } = vi.hoisted(() => ({
  FAKE_HOME: require("path").resolve(require("os").tmpdir(), `minions-fakehome-${process.pid}`),
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
    const db = initSidecar(project, {
      defaultModel: "claude-sonnet-5", defaultLeaderHarness: "codex", defaultLeaderModel: "gpt-5.6-sol",
      defaultMinionHarness: "claude", defaultMinionModel: "claude-sonnet-5", mechanicalMinionModel: "claude-haiku-4-5",
      reasoningMinionModel: "claude-opus-4-8", defaultPermissionMode: "auto", defaultWorktreeIsolation: false,
    });
    // On Windows, SQLite holds a file lock until the connection is closed.
    // Push the close before the project rmSync so afterEach cleanup succeeds.
    cleanup.push(() => db.close());
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
    // Leader defaults to Codex GPT-5.6; minions stay on Claude.
    expect(settings.defaultLeaderHarness).toBe("codex");
    expect(settings.defaultLeaderModel).toBe("gpt-5.6-sol");
    expect(settings.defaultMinionModel).toBe("claude-sonnet-5");
    expect(settings.mechanicalMinionModel).toBe("claude-haiku-4-5");
    expect(settings.reasoningMinionModel).toBe("claude-opus-4-8");
    expect(settings.defaultPermissionMode).toBeTruthy();
    expect(typeof settings.defaultWorktreeIsolation).toBe("boolean");
  });

  it("openProjectDb initialises without provider defaults and re-uses an existing sidecar", () => {
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
    // Capture the db handle so afterEach can close it before the project dir
    // is deleted.  On Windows, SQLite holds a file lock until close().
    const db = initSidecar(project, {});
    cleanup.push(() => db.close());
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
    // readSettings merges in defaults for new harness fields; assert written values are preserved
    expect(readSettings(project)).toMatchObject(next);
  });

  it("migrates untouched legacy dashboard shortcuts to the array, preserving custom ones", () => {
    writeSettings(project, {
      dashboardLeaderActionNames: {
        improve: "Improve",
        execute: "Ship it",
        analyze: "Analyze",
      },
      dashboardLeaderActionPrompts: {
        improve: "Improve the connected dashboard context. Identify the highest-impact changes, then implement or produce the improved result.",
        execute: "Use my custom implementation workflow.",
        analyze: "Analyze the connected dashboard context. Summarize the key findings, risks, and recommended next steps.",
      },
    } as never);

    const settings = readSettings(project);
    // Legacy records are dropped in favour of the ordered array.
    expect(settings["dashboardLeaderActionNames"]).toBeUndefined();
    expect(settings["dashboardLeaderActionPrompts"]).toBeUndefined();

    const actions = settings.dashboardLeaderActions ?? [];
    const byId = Object.fromEntries(actions.map((a) => [a.id, a]));

    // `execute` name is customized ("Ship it") so it is preserved, but its
    // untouched-default prompt was replaced by a custom one → kept verbatim.
    expect(byId.execute?.name).toBe("Ship it");
    expect(byId.execute?.prompt).toBe("Use my custom implementation workflow.");

    // `improve` and `analyze` matched the untouched legacy defaults → upgraded.
    expect(byId.improve?.name).toBe("Fix");
    expect(byId.improve?.prompt).toContain("root cause");
    expect(byId.analyze?.name).toBe("Review");
    expect(byId.analyze?.prompt).toContain("Do not make changes");
  });

  it("uses medium leader thinking for fable when no explicit setting is stored", () => {
    writeSettings(project, {
      defaultLeaderModel: "claude-fable-5",
    });

    expect(readSettings(project).defaultLeaderThinkingConfig?.effort).toBe("medium");
  });

  it("preserves an explicit stored leader thinking effort for fable", () => {
    writeSettings(project, {
      defaultLeaderModel: "claude-fable-5",
      defaultLeaderThinkingConfig: {
        enabled: true,
        effort: "high",
        display: "summarized",
      },
    });

    expect(readSettings(project).defaultLeaderThinkingConfig?.effort).toBe("high");
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
