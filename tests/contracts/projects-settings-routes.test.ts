/**
 * Contract tests for the per-project settings/context/skills/MCP routes.
 *
 *   GET  /:encodedPath/context        read context.md
 *   PUT  /:encodedPath/context        write context.md
 *   GET  /:encodedPath/settings       read settings.json
 *   PUT  /:encodedPath/settings       write settings.json
 *   GET  /:encodedPath/skills         read skills.json
 *   PUT  /:encodedPath/skills         write skills.json (must be array)
 *   GET  /:encodedPath/mcp-servers    list registered MCP servers
 *   PUT  /:encodedPath/mcp-servers/:id  upsert
 *   DELETE /:encodedPath/mcp-servers/:id  remove
 *
 * Path-guard requires the project to live under $HOME, so the harness
 * uses ~/.tmp/.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { Router } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { FAKE_HOME } = vi.hoisted(() => ({
  FAKE_HOME: require("path").resolve(require("os").tmpdir(), `minions-fakehome-projects-settings-${process.pid}`),
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: { ...actual, homedir: () => FAKE_HOME },
    homedir: () => FAKE_HOME,
  };
});

import { mountSettingsRoutes } from "../../server/routes/projects/settings.ts";
import { initSidecar } from "../../server/project-store.ts";
import {
  registerProjectPath,
  unregisterProjectPath,
} from "../../server/path-guard.ts";
import { createExpressFetch } from "../harness/in-process-http.ts";

// On Windows, SQLite holds a file lock until the connection is closed.
// Track the db returned by initSidecar and close it in afterEach so
// afterAll's rmSync(FAKE_HOME) can delete canvas.db without EBUSY.
let sidecarDb: { close(): void } | undefined;

function encodePath(p: string): string {
  return Buffer.from(p).toString("base64url");
}

function buildApp(): express.Express {
  const router = Router();
  mountSettingsRoutes(router);
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/", router);
  return app;
}

let fetch: typeof globalThis.fetch;
let baseUrl: string;
let parentDir: string;
let project: string;
let encoded: string;

beforeAll(async () => {
  fs.mkdirSync(FAKE_HOME, { recursive: true });
  const tmpBase = path.join(os.homedir(), ".tmp");
  fs.mkdirSync(tmpBase, { recursive: true });
  parentDir = fs.mkdtempSync(
    path.join(tmpBase, "projects-settings-routes-"),
  );
  baseUrl = "http://in-process.local";
  fetch = createExpressFetch(buildApp(), baseUrl);
});

afterAll(async () => {
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  project = fs.mkdtempSync(path.join(parentDir, "p-"));
  registerProjectPath(project);
  encoded = encodePath(project);
  sidecarDb = initSidecar(project, {});
});

afterEach(() => {
  // Close the SQLite connection so afterAll's rmSync can delete the db file.
  try { sidecarDb?.close(); } catch { /* ignore */ }
  sidecarDb = undefined;
});

describe("context routes", () => {
  it("PUT then GET round-trips the markdown bytes", async () => {
    const md = "# Project Title\n\nA paragraph with `code`.\n";

    const putRes = await fetch(`${baseUrl}/${encoded}/context`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: md }),
    });
    expect(putRes.status).toBe(200);

    const getRes = await fetch(`${baseUrl}/${encoded}/context`);
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as { content: string; exists: boolean };
    expect(body.exists).toBe(true);
    expect(body.content).toBe(md);
  });

  it("GET on an unregistered project returns 403", async () => {
    unregisterProjectPath(project);
    const res = await fetch(`${baseUrl}/${encoded}/context`);
    expect(res.status).toBe(403);
  });
});

describe("settings routes", () => {
  it("PUT then GET round-trips the settings object", async () => {
    const settings = {
      defaultModel: "opus",
      defaultPermissionMode: "review",
      defaultWorktreeIsolation: true,
      customExtra: { nested: 1 },
    };
    await fetch(`${baseUrl}/${encoded}/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    });

    const getRes = await fetch(`${baseUrl}/${encoded}/settings`);
    const body = (await getRes.json()) as Record<string, unknown>;
    // readSettings merges in defaults for new harness fields; assert written values are preserved
    expect(body).toMatchObject(settings);
  });

  it("GET returns the documented defaults when settings.json is absent", async () => {
    fs.rmSync(path.join(project, ".minions", "settings.json"), {
      force: true,
    });
    const res = await fetch(`${baseUrl}/${encoded}/settings`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["defaultModel"]).toBeDefined();
    expect(body["defaultPermissionMode"]).toBeDefined();
    expect(body["roleSystemBeta"]).toBe(false);
  });
});

describe("skills routes", () => {
  it("PUT then GET round-trips the skills array", async () => {
    const skills = [
      { id: "alpha", body: "do alpha" },
      { id: "beta", body: "do beta" },
    ];
    await fetch(`${baseUrl}/${encoded}/skills`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(skills),
    });

    const getRes = await fetch(`${baseUrl}/${encoded}/skills`);
    expect(await getRes.json()).toEqual(skills);
  });

  it("PUT rejects a non-array body with 400", async () => {
    const res = await fetch(`${baseUrl}/${encoded}/skills`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wrong: "shape" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("MCP servers routes", () => {
  it("PUT upserts and GET lists the entry; DELETE removes it", async () => {
    const entry = {
      id: "render",
      name: "Render server",
      transport: "stdio",
      command: "node",
      args: ["render-server.js"],
      env: {},
    };
    const putRes = await fetch(
      `${baseUrl}/${encoded}/mcp-servers/render`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(entry),
      },
    );
    expect(putRes.status).toBe(200);

    const listRes = await fetch(`${baseUrl}/${encoded}/mcp-servers`);
    const list = (await listRes.json()) as {
      entries: Array<{ id: string }>;
      invalid: unknown[];
    };
    expect(list.entries.map((e) => e.id)).toEqual(["render"]);
    expect(list.invalid).toEqual([]);

    const delRes = await fetch(
      `${baseUrl}/${encoded}/mcp-servers/render`,
      { method: "DELETE" },
    );
    expect(delRes.status).toBe(200);

    const after = (await (
      await fetch(`${baseUrl}/${encoded}/mcp-servers`)
    ).json()) as { entries: unknown[] };
    expect(after.entries).toEqual([]);
  });

  it("DELETE returns 404 when the server id was never registered", async () => {
    const res = await fetch(`${baseUrl}/${encoded}/mcp-servers/ghost`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("PUT returns 400 when the entry payload is malformed (zod rejects)", async () => {
    const res = await fetch(`${baseUrl}/${encoded}/mcp-servers/x`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "x", name: "X" /* missing transport */ }),
    });
    expect(res.status).toBe(400);
  });
});
