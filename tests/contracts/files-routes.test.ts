/**
 * Contract tests for the write-oriented /api/files routes.
 *
 * These pin symlink handling at the route boundary: writes must not follow a
 * project-local symlink into a location outside the registered project root.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { FAKE_HOME } = vi.hoisted(() => ({
  FAKE_HOME: `/tmp/minions-fakehome-files-routes-${process.pid}`,
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: { ...actual, homedir: () => FAKE_HOME },
    homedir: () => FAKE_HOME,
  };
});

import { registerProjectPath } from "../../server/path-guard.ts";
import { createFileRoutes } from "../../server/routes/files.ts";
import { createExpressFetch } from "../harness/in-process-http.ts";

function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use("/", createFileRoutes());
  return app;
}

async function postJson(pathname: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

let fetch: typeof globalThis.fetch;
let baseUrl: string;
let parentDir: string;
let project: string;
let outsideDir: string;

beforeAll(() => {
  fs.mkdirSync(FAKE_HOME, { recursive: true });
  const tmpBase = path.join(os.homedir(), ".tmp");
  fs.mkdirSync(tmpBase, { recursive: true });
  parentDir = fs.mkdtempSync(path.join(tmpBase, "files-routes-"));
  baseUrl = "http://in-process.local";
  fetch = createExpressFetch(buildApp(), baseUrl);
});

afterAll(() => {
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
});

afterEach(() => {
  if (outsideDir) {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  project = fs.mkdtempSync(path.join(parentDir, "p-"));
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "files-routes-outside-"));
  fs.symlinkSync(outsideDir, path.join(project, "outside"));
  registerProjectPath(project);
});

describe("GET /list-dirs", () => {
  it("rejects listing through a symlinked directory outside the project root", async () => {
    const params = new URLSearchParams({
      projectPath: project,
      subPath: "outside",
    });

    const res = await fetch(`${baseUrl}/list-dirs?${params}`);
    expect(res.status).toBe(403);
  });
});

describe("POST /save", () => {
  it("rejects saving through a symlinked parent outside the project root", async () => {
    const res = await postJson("/save", {
      projectPath: project,
      filePath: "outside/new.txt",
      content: "secret",
    });

    expect(res.status).toBe(403);
    expect(fs.existsSync(path.join(outsideDir, "new.txt"))).toBe(false);
  });
});

describe("POST /upload", () => {
  it("rejects uploading through a symlinked parent outside the project root", async () => {
    const res = await postJson("/upload", {
      projectPath: project,
      filePath: "outside/upload.bin",
      contentBase64: Buffer.from("secret").toString("base64"),
    });

    expect(res.status).toBe(403);
    expect(fs.existsSync(path.join(outsideDir, "upload.bin"))).toBe(false);
  });
});

describe("POST /move", () => {
  it("rejects moving into a symlinked parent outside the project root", async () => {
    fs.writeFileSync(path.join(project, "local.txt"), "local");

    const res = await postJson("/move", {
      projectPath: project,
      fromPath: "local.txt",
      toPath: "outside/moved.txt",
    });

    expect(res.status).toBe(403);
    expect(fs.existsSync(path.join(project, "local.txt"))).toBe(true);
    expect(fs.existsSync(path.join(outsideDir, "moved.txt"))).toBe(false);
  });

  it("rejects moving a symlink final target", async () => {
    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "secret");
    fs.symlinkSync(outsideFile, path.join(project, "linked-secret.txt"));

    const res = await postJson("/move", {
      projectPath: project,
      fromPath: "linked-secret.txt",
      toPath: "moved.txt",
    });

    expect(res.status).toBe(403);
    expect(fs.existsSync(outsideFile)).toBe(true);
  });
});

describe("POST /delete", () => {
  it("rejects deleting a symlink final target", async () => {
    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "secret");
    fs.symlinkSync(outsideFile, path.join(project, "linked-secret.txt"));

    const res = await postJson("/delete", {
      projectPath: project,
      filePath: "linked-secret.txt",
    });

    expect(res.status).toBe(403);
    expect(fs.existsSync(outsideFile)).toBe(true);
    expect(fs.lstatSync(path.join(project, "linked-secret.txt")).isSymbolicLink()).toBe(true);
  });
});

describe("POST /mkdir", () => {
  it("rejects creating a directory through a symlinked parent outside the project root", async () => {
    const res = await postJson("/mkdir", {
      projectPath: project,
      dirPath: "outside/new-dir",
    });

    expect(res.status).toBe(403);
    expect(fs.existsSync(path.join(outsideDir, "new-dir"))).toBe(false);
  });
});
