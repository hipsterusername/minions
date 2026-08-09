/**
 * Contract tests for the core project REST routes.
 *
 * Spins up a real Express app with `mountCoreRoutes`, points it at a
 * tmpdir under a *mocked* home directory, and drives every documented
 * endpoint via native fetch:
 *
 *   GET    /                       lists recent projects
 *   POST   /                       creates a new project + sidecar
 *   POST   /open                   opens an existing folder
 *   GET    /:encodedPath           full project + nodes + sidecar files
 *   PUT    /:encodedPath           update name / transform
 *   DELETE /:encodedPath           remove from recent list
 *   PUT    /:encodedPath/state     bulk save: replace nodes + transform
 *
 * These are real producer/consumer round-trips: the Express handler is the
 * producer, fetch is the consumer. No mocks at the HTTP layer.
 *
 * **Why we mock `node:os` here.** `server/project-store.ts` captures
 * `os.homedir()` at module-load time:
 *
 *   const GLOBAL_DIR = path.join(os.homedir(), ".minions");
 *   const RECENT_PROJECTS_FILE = path.join(GLOBAL_DIR, "recent-projects.json");
 *
 * Without the mock, `POST /` (which writes via `addRecentProject`) lands
 * entries in the developer's REAL `~/.minions/recent-projects.json`
 * and the entries appear in the live app's recent-projects list — every
 * pre-commit / CI run pollutes the user's home. The hoisted mock below
 * mirrors `server/project-store.test.ts` and points the recent-projects
 * file at a per-PID tmpdir.
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
import express, { Router } from "express";
import fs from "node:fs";
import path from "node:path";

// Hoisted alongside the `vi.mock` factory below — see comment in the
// module docstring for why this isolation matters.
const { FAKE_HOME } = vi.hoisted(() => ({
  FAKE_HOME: require("path").resolve(require("os").tmpdir(), `minions-fakehome-projects-core-${process.pid}`),
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: { ...actual, homedir: () => FAKE_HOME },
    homedir: () => FAKE_HOME,
  };
});

import os from "node:os";

import { mountCoreRoutes } from "../../server/routes/projects/core.ts";
import {
  registerProjectPath,
  unregisterProjectPath,
} from "../../server/path-guard.ts";
import {
  getDb,
  deleteDbCache,
} from "../../server/routes/projects/helpers.ts";
import { addRecentProject, hasSidecar, initSidecar } from "../../server/project-store.ts";
import { resolveWorkspace } from "../../server/workspace-registry.ts";
import { initDb } from "../../server/db.ts";
import { createExpressFetch } from "../harness/in-process-http.ts";

function encodePath(p: string): string {
  return Buffer.from(p).toString("base64url");
}

function buildApp(): express.Express {
  const router = Router();
  mountCoreRoutes(router, { getReadiness: async () => ({
    schemaVersion: 1, checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString(),
    ready: true, readyHarnesses: ["claude", "codex"], harnesses: [],
  }) });
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/", router);
  return app;
}

let fetch: typeof globalThis.fetch;
let baseUrl: string;
let parentDir: string; // ~/.tmp/projects-core-routes-XXXX

beforeAll(async () => {
  // Materialise the FAKE_HOME promised to the mocked `os.homedir()` so
  // that `~/.tmp/...` paths resolve under it. Path-guard requires a
  // home-rooted path; the mock makes that home a per-PID tmpdir.
  fs.mkdirSync(FAKE_HOME, { recursive: true });
  const tmpBase = path.join(os.homedir(), ".tmp");
  fs.mkdirSync(tmpBase, { recursive: true });
  parentDir = fs.mkdtempSync(path.join(tmpBase, "projects-core-routes-"));
  baseUrl = "http://in-process.local";
  fetch = createExpressFetch(buildApp(), baseUrl);
});

afterAll(async () => {
  // Wipe the entire fake home — including the recent-projects.json
  // entries this suite appended — so successive runs start clean.
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
});

// Per-test isolation: each test runs against its own subdir + its own
// path-guard registration. Cleanup runs in afterEach.
let project: string;
let encoded: string;

beforeEach(() => {
  project = fs.mkdtempSync(path.join(parentDir, "p-"));
  registerProjectPath(project);
  encoded = encodePath(project);
});

// Close any cached SQLite connection for `project` so afterAll's
// rmSync(FAKE_HOME) can delete canvas.db without EBUSY on Windows.
// Only close when the sidecar was actually initialised (db file present).
afterEach(() => {
  try {
    if (hasSidecar(project)) {
      getDb(project).close();
      deleteDbCache(project);
    }
  } catch { /* ignore */ }
});

function teardownProject() {
  unregisterProjectPath(project);
  // Don't rm the tmpdir between tests — afterAll handles bulk cleanup.
}

describe("POST /  — create project", () => {
  it("creates a clean source with UUID-addressed central state", async () => {
    teardownProject(); // we'll re-register through POST.
    const newPath = path.join(parentDir, "fresh-create");

    const res = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fresh", path: newPath }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body["name"]).toBe("Fresh");
    expect(body["path"]).toBe(newPath);
    expect(body["id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(body["transform"]).toEqual({ x: 0, y: 0, scale: 1 });
    expect(typeof body["createdAt"]).toBe("string");

    const workspace = resolveWorkspace(body["id"] as string)!;
    expect(workspace.sourceRoot).toBe(fs.realpathSync(newPath));
    expect(fs.existsSync(path.join(newPath, ".minions"))).toBe(false);
    expect(fs.existsSync(path.join(workspace.stateRoot, "context.md"))).toBe(true);

    const uuidRes = await fetch(`${baseUrl}/${body["id"] as string}`);
    expect(uuidRes.status).toBe(200);

    // On Windows, SQLite holds a file lock until the connection is explicitly
    // closed. The POST handler cached the db via setDbCache; close it before
    // rmSync so the canvas.db file is not busy.
    try { getDb(newPath).close(); deleteDbCache(newPath); } catch { /* ignore */ }
    fs.rmSync(newPath, { recursive: true, force: true });
  });

  it("returns 400 when path is missing", async () => {
    const res = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "no path" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("path");
  });

  it("registers an absolute source root outside the home directory", async () => {
    const mountedParent = fs.mkdtempSync(path.join(os.tmpdir(), "mounted-projects-core-"));
    const mountedProject = path.join(mountedParent, "project");
    const res = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: mountedProject }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; path: string };
    expect(body.path).toBe(mountedProject);
    expect(resolveWorkspace(body.id)?.sourceRoot).toBe(fs.realpathSync(mountedProject));
    try { getDb(mountedProject).close(); deleteDbCache(mountedProject); } catch { /* ignore */ }
    fs.rmSync(mountedParent, { recursive: true, force: true });
  });
});

describe("POST /open — open existing project", () => {
  it("migrates a legacy recent and sidecar non-destructively", async () => {
    const legacyRoot = path.join(project, ".minions");
    fs.mkdirSync(legacyRoot);
    const legacyDb = initDb(path.join(legacyRoot, "canvas.db"));
    const legacyId = "11111111-1111-4111-8111-111111111111";
    legacyDb.prepare("INSERT INTO projects (id, name) VALUES (?, ?)").run(legacyId, "Legacy");
    legacyDb.close();
    fs.writeFileSync(path.join(legacyRoot, "context.md"), "legacy");
    addRecentProject(project, "Legacy");

    const restartedFetch = createExpressFetch(buildApp(), baseUrl);
    const listRes = await restartedFetch(`${baseUrl}/`);
    const rows = (await listRes.json()) as Array<{ id: string; path: string }>;
    const migrated = rows.find((row) => row.path === project)!;
    expect(migrated.id).toBe(legacyId);

    const openRes = await restartedFetch(`${baseUrl}/${migrated.id}`);
    expect(openRes.status).toBe(200);
    const workspace = resolveWorkspace(migrated.id)!;
    expect(fs.readFileSync(path.join(workspace.stateRoot, "context.md"), "utf8")).toBe("legacy");
    expect(fs.readFileSync(path.join(project, ".minions", "context.md"), "utf8")).toBe("legacy");
  });

  it("returns the project + nodes when the directory exists", async () => {
    teardownProject();
    const res = await fetch(`${baseUrl}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: project }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["path"]).toBe(project);
    expect(body["nodes"]).toEqual([]);
  });

  it("returns 404 when the directory does not exist", async () => {
    teardownProject();
    const ghost = path.join(parentDir, "ghost-dir");
    const res = await fetch(`${baseUrl}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: ghost }),
    });
    expect(res.status).toBe(404);
  });
});

describe("workspace identity lifecycle", () => {
  it("rebinds a moved repository while preserving UUID and central state", async () => {
    teardownProject();
    const openRes = await fetch(`${baseUrl}/open`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: project }),
    });
    const opened = (await openRes.json()) as { id: string };
    const before = resolveWorkspace(opened.id)!;
    fs.writeFileSync(path.join(before.stateRoot, "identity-marker.txt"), "preserved");
    const moved = `${project}-moved`;
    fs.renameSync(project, moved);

    const rebindRes = await fetch(`${baseUrl}/rebind`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: opened.id, path: moved }),
    });
    expect(rebindRes.status).toBe(200);
    const rebound = (await rebindRes.json()) as { id: string; sourceRoot: string };
    expect(rebound).toMatchObject({ id: opened.id, sourceRoot: fs.realpathSync(moved) });
    expect(fs.readFileSync(path.join(resolveWorkspace(opened.id)!.stateRoot,
      "identity-marker.txt"), "utf8")).toBe("preserved");
    project = moved;
  });

  it("attaches an already-opened copy to the chosen existing UUID", async () => {
    teardownProject();
    const originalRes = await fetch(`${baseUrl}/open`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: project }),
    });
    const original = (await originalRes.json()) as { id: string };
    const copy = fs.mkdtempSync(path.join(parentDir, "copy-"));
    const copyRes = await fetch(`${baseUrl}/open`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: copy }),
    });
    const copied = (await copyRes.json()) as { id: string };
    expect(copied.id).not.toBe(original.id);

    const attachRes = await fetch(`${baseUrl}/attach`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: original.id, path: copy }),
    });
    expect(attachRes.status).toBe(200);
    expect(await attachRes.json()).toMatchObject({
      id: original.id, workspaceId: original.id, sourceRoot: fs.realpathSync(copy),
    });
    expect(resolveWorkspace(copied.id)).toBeNull();
    expect((await fetch(`${baseUrl}/${copied.id}`)).status).toBe(403);
    const attachedGet = await fetch(`${baseUrl}/${original.id}`);
    expect(attachedGet.status).toBe(200);
    expect(await attachedGet.json()).toMatchObject({ id: original.id, path: fs.realpathSync(copy) });
    project = copy;
  });
});

describe("GET /:encodedPath — load project", () => {
  it("returns the project + empty nodes after registration", async () => {
    const res = await fetch(`${baseUrl}/${encoded}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["path"]).toBe(project);
    expect(body["nodes"]).toEqual([]);
    expect(body["context"]).toBeDefined();
    expect(body["settings"]).toBeDefined();
  });

  it("returns 403 for an unregistered project", async () => {
    teardownProject();
    const res = await fetch(`${baseUrl}/${encoded}`);
    expect(res.status).toBe(403);
  });

  it("returns 403 for an unknown workspace UUID", async () => {
    const res = await fetch(`${baseUrl}/00000000-0000-4000-8000-000000000000`);
    expect(res.status).toBe(403);
  });
});

describe("PUT /:encodedPath — update project", () => {
  it("updates name and transform, returns the updated project", async () => {
    // Bootstrap a project row first.
    await fetch(`${baseUrl}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: project }),
    });

    const res = await fetch(`${baseUrl}/${encoded}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "renamed",
        transform: { x: 100, y: 200, scale: 1.5 },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["name"]).toBe("renamed");
    expect(body["transform"]).toEqual({ x: 100, y: 200, scale: 1.5 });

    // Re-fetch to verify persistence.
    const getRes = await fetch(`${baseUrl}/${encoded}`);
    const fresh = (await getRes.json()) as Record<string, unknown>;
    expect(fresh["name"]).toBe("renamed");
    expect(fresh["transform"]).toEqual({ x: 100, y: 200, scale: 1.5 });

    const listRes = await fetch(`${baseUrl}/`);
    const listed = (await listRes.json()) as Array<Record<string, unknown>>;
    expect(listed.find((row) => row["path"] === project)).toMatchObject({
      workspaceId: expect.any(String), nickname: "renamed", name: "renamed",
      sourceRoot: project,
    });
  });
});

describe("PUT /:encodedPath/state — bulk save", () => {
  it("replaces nodes + transform atomically", async () => {
    await fetch(`${baseUrl}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: project }),
    });

    const stateRes = await fetch(`${baseUrl}/${encoded}/state`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        transform: { x: 5, y: 5, scale: 1 },
        nodes: [
          {
            id: "n1",
            type: "markdown",
            position: { x: 10, y: 20 },
            size: { width: 200, height: 100 },
            data: { text: "hello" },
          },
          {
            id: "n2",
            type: "markdown",
            position: { x: 30, y: 40 },
            size: { width: 200, height: 100 },
            data: { text: "world" },
          },
        ],
        graph: {
          edges: [
            {
              id: "e1",
              sourceNodeId: "n1",
              sourcePortId: "context-out",
              targetNodeId: "n2",
              targetPortId: "context-in",
              protocol: "context",
            },
          ],
        },
      }),
    });
    expect(stateRes.status).toBe(200);

    const getRes = await fetch(`${baseUrl}/${encoded}`);
    const body = (await getRes.json()) as {
      nodes: Array<{ id: string; data: unknown }>;
      graph: { edges: Array<{ id: string; sourceNodeId: string; targetNodeId: string }> };
    };
    expect(body.nodes.map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(body.nodes[0]!.data).toEqual({ text: "hello" });
    expect(body.graph.edges).toEqual([
      expect.objectContaining({
        id: "e1",
        sourceNodeId: "n1",
        targetNodeId: "n2",
      }),
    ]);
  });

  it("a second bulk save replaces edges — does not append", async () => {
    await fetch(`${baseUrl}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: project }),
    });

    const nodes = [
      { id: "a", type: "x", position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, data: {} },
      { id: "b", type: "x", position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, data: {} },
      { id: "c", type: "x", position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, data: {} },
    ];

    await fetch(`${baseUrl}/${encoded}/state`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nodes,
        graph: {
          edges: [
            {
              id: "e1",
              sourceNodeId: "a",
              sourcePortId: "out",
              targetNodeId: "b",
              targetPortId: "in",
              protocol: "context",
            },
            {
              id: "e2",
              sourceNodeId: "b",
              sourcePortId: "out",
              targetNodeId: "c",
              targetPortId: "in",
              protocol: "context",
            },
          ],
        },
      }),
    });

    await fetch(`${baseUrl}/${encoded}/state`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nodes,
        graph: {
          edges: [
            {
              id: "e3",
              sourceNodeId: "a",
              sourcePortId: "out",
              targetNodeId: "c",
              targetPortId: "in",
              protocol: "context",
            },
          ],
        },
      }),
    });

    const getRes = await fetch(`${baseUrl}/${encoded}`);
    const body = (await getRes.json()) as { graph: { edges: Array<{ id: string }> } };
    expect(body.graph.edges.map((e) => e.id)).toEqual(["e3"]);
  });

  it("a second bulk save replaces — does not append", async () => {
    await fetch(`${baseUrl}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: project }),
    });

    // First save: 2 nodes.
    await fetch(`${baseUrl}/${encoded}/state`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nodes: [
          { id: "a", type: "x", position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, data: {} },
          { id: "b", type: "x", position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, data: {} },
        ],
      }),
    });
    // Second save: 1 node.
    await fetch(`${baseUrl}/${encoded}/state`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nodes: [
          { id: "c", type: "x", position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, data: {} },
        ],
      }),
    });

    const getRes = await fetch(`${baseUrl}/${encoded}`);
    const body = (await getRes.json()) as { nodes: Array<{ id: string }> };
    expect(body.nodes.map((n) => n.id)).toEqual(["c"]);
  });
});

describe("DELETE /:encodedPath — drop from recent", () => {
  it("removes the project from recents and unregisters it (subsequent GET returns 403)", async () => {
    // Bootstrap.
    await fetch(`${baseUrl}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: project }),
    });

    // The DELETE route drops the cache entry; close the Windows file
    // handle first so fixture cleanup can remove the fake home.
    try { getDb(project).close(); deleteDbCache(project); } catch { /* ignore */ }

    const delRes = await fetch(`${baseUrl}/${encoded}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);
    const body = (await delRes.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Removal also revokes access through the project path guard.
    const getRes = await fetch(`${baseUrl}/${encoded}`);
    expect(getRes.status).toBe(403);

    // The folder itself is NOT deleted (documented behaviour).
    expect(fs.existsSync(project)).toBe(true);
  });
});

describe("GET / — list recents", () => {
  it("returns an array of project summaries", async () => {
    await fetch(`${baseUrl}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: project }),
    });
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ path: string }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((p) => p.path === project)).toBe(true);
  });
});
