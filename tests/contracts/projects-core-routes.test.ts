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
 * Per docs/testing-strategy.md §5.4 these are real producer/consumer
 * round-trips: the express handler is the producer, fetch is the
 * consumer. No mocks at the HTTP layer.
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
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import express, { Router } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import path from "node:path";

// Hoisted alongside the `vi.mock` factory below — see comment in the
// module docstring for why this isolation matters.
const { FAKE_HOME } = vi.hoisted(() => ({
  FAKE_HOME: `/tmp/minions-fakehome-projects-core-${process.pid}`,
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

function encodePath(p: string): string {
  return Buffer.from(p).toString("base64url");
}

function buildApp(): express.Express {
  const router = Router();
  mountCoreRoutes(router);
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/", router);
  return app;
}

let server: Server;
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
  server = createServer(buildApp());
  baseUrl = await new Promise<string>((resolve) => {
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://localhost:${port}`);
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
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

function teardownProject() {
  unregisterProjectPath(project);
  // Don't rm the tmpdir between tests — afterAll handles bulk cleanup.
}

describe("POST /  — create project", () => {
  it("creates the directory + sidecar and returns the project shape", async () => {
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
    expect(body["id"]).toBe(encodePath(newPath));
    expect(body["transform"]).toEqual({ x: 0, y: 0, scale: 1 });
    expect(typeof body["createdAt"]).toBe("string");

    // Sidecar materialised on disk.
    expect(fs.existsSync(path.join(newPath, ".minions"))).toBe(true);
    expect(
      fs.existsSync(path.join(newPath, ".minions", "context.md")),
    ).toBe(true);

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

  it("returns 403 for a path outside home directory", async () => {
    const res = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/etc/something" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /open — open existing project", () => {
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
      }),
    });
    expect(stateRes.status).toBe(200);

    const getRes = await fetch(`${baseUrl}/${encoded}`);
    const body = (await getRes.json()) as { nodes: Array<{ id: string; data: unknown }> };
    expect(body.nodes.map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(body.nodes[0]!.data).toEqual({ text: "hello" });
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

    const delRes = await fetch(`${baseUrl}/${encoded}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);
    const body = (await delRes.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // GET now blocked by path-guard.
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
