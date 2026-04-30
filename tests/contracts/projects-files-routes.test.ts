/**
 * Contract tests for the per-project file-browser routes.
 *
 *   GET /:encodedPath/file?path=<rel>      read a single file's contents
 *   GET /:encodedPath/ls?path=<rel>        directory listing (one level)
 *   GET /:encodedPath/tree?depth=N         recursive tree
 *
 * These are read-only file-system probes. Path-traversal is intentionally
 * tested — the handler must reject `..` escapes with 403.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express, { Router } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { mountFileRoutes } from "../../server/routes/projects/files.ts";
import {
  registerProjectPath,
  unregisterProjectPath,
} from "../../server/path-guard.ts";

function encodePath(p: string): string {
  return Buffer.from(p).toString("base64url");
}

function buildApp(): express.Express {
  const router = Router();
  mountFileRoutes(router);
  const app = express();
  app.use(express.json());
  app.use("/", router);
  return app;
}

let server: Server;
let baseUrl: string;
let parentDir: string;
let project: string;
let encoded: string;

beforeAll(async () => {
  const tmpBase = path.join(os.homedir(), ".tmp");
  fs.mkdirSync(tmpBase, { recursive: true });
  parentDir = fs.mkdtempSync(path.join(tmpBase, "projects-files-routes-"));
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
  fs.rmSync(parentDir, { recursive: true, force: true });
});

beforeEach(() => {
  project = fs.mkdtempSync(path.join(parentDir, "p-"));
  registerProjectPath(project);
  encoded = encodePath(project);
});

describe("GET /file — read file", () => {
  it("returns the file contents and metadata for a small file", async () => {
    fs.writeFileSync(path.join(project, "hello.txt"), "hi from test");
    const res = await fetch(
      `${baseUrl}/${encoded}/file?path=hello.txt`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["path"]).toBe("hello.txt");
    expect(body["content"]).toBe("hi from test");
    expect(body["truncated"]).toBe(false);
  });

  it("truncates files over the 512KB cap and sets truncated=true", async () => {
    const bigPath = path.join(project, "big.txt");
    // Write 600KB so we cross the 512KB threshold.
    fs.writeFileSync(bigPath, "a".repeat(600 * 1024));
    const res = await fetch(`${baseUrl}/${encoded}/file?path=big.txt`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["truncated"]).toBe(true);
    expect((body["content"] as string).length).toBe(512 * 1024);
    expect(body["size"]).toBe(600 * 1024);
  });

  it("returns 404 for a missing file", async () => {
    const res = await fetch(`${baseUrl}/${encoded}/file?path=ghost.txt`);
    expect(res.status).toBe(404);
  });

  it("returns 400 when the path query is missing", async () => {
    const res = await fetch(`${baseUrl}/${encoded}/file`);
    expect(res.status).toBe(400);
  });

  it("rejects path traversal with 403", async () => {
    const res = await fetch(
      `${baseUrl}/${encoded}/file?path=${encodeURIComponent("../../etc/passwd")}`,
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when target is a directory, not a file", async () => {
    fs.mkdirSync(path.join(project, "subdir"));
    const res = await fetch(`${baseUrl}/${encoded}/file?path=subdir`);
    expect(res.status).toBe(400);
  });
});

describe("GET /ls — directory listing", () => {
  it("returns a sorted list of dirs first, then files, skipping ignored names", async () => {
    fs.mkdirSync(path.join(project, "src"));
    fs.mkdirSync(path.join(project, "docs"));
    fs.mkdirSync(path.join(project, "node_modules")); // ignored
    fs.writeFileSync(path.join(project, "README.md"), "x");
    fs.writeFileSync(path.join(project, "package.json"), "{}");

    const res = await fetch(`${baseUrl}/${encoded}/ls`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      path: string;
      entries: Array<{ name: string; type: "dir" | "file" }>;
    };
    const names = body.entries.map((e) => e.name);
    // dirs first (alpha), then files (case-insensitive alpha via
    // localeCompare → 'p' beats 'R'). node_modules is filtered.
    expect(names).toEqual(["docs", "src", "package.json", "README.md"]);
    expect(body.entries[0]!.type).toBe("dir");
    expect(body.entries[2]!.type).toBe("file");
  });

  it("rejects path traversal with 403", async () => {
    const res = await fetch(
      `${baseUrl}/${encoded}/ls?path=${encodeURIComponent("../..")}`,
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 when the listed path is not a directory", async () => {
    fs.writeFileSync(path.join(project, "file.txt"), "x");
    const res = await fetch(`${baseUrl}/${encoded}/ls?path=file.txt`);
    expect(res.status).toBe(404);
  });
});

describe("GET /tree — recursive listing", () => {
  it("returns a nested tree up to maxDepth=2 by default", async () => {
    fs.mkdirSync(path.join(project, "src"));
    fs.mkdirSync(path.join(project, "src", "nested"));
    fs.writeFileSync(path.join(project, "src", "a.ts"), "x");
    fs.writeFileSync(path.join(project, "src", "nested", "b.ts"), "x");

    const res = await fetch(`${baseUrl}/${encoded}/tree`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      root: string;
      tree: Array<{
        name: string;
        type: "dir" | "file";
        children?: Array<{ name: string }>;
      }>;
    };

    expect(body.root).toBe(path.basename(project));
    const src = body.tree.find((n) => n.name === "src")!;
    expect(src.type).toBe("dir");
    // depth 2 → src.children populated, including nested subdir.
    expect(src.children!.map((c) => c.name).sort()).toEqual([
      "a.ts",
      "nested",
    ]);
  });

  it("clamps depth to a maximum of 4 when a larger value is requested", async () => {
    // Build 5 levels deep; with the depth clamp tree only descends 4 levels.
    let dir = project;
    for (const name of ["d1", "d2", "d3", "d4", "d5"]) {
      dir = path.join(dir, name);
      fs.mkdirSync(dir);
    }
    const res = await fetch(`${baseUrl}/${encoded}/tree?depth=10`);
    const body = (await res.json()) as {
      tree: Array<{ name: string; children?: unknown[] }>;
    };
    // Walk down 4 levels; d5 must be reachable as a leaf without children.
    let cur: { name: string; children?: unknown[] } = body.tree[0]!;
    for (const expected of ["d1", "d2", "d3", "d4"]) {
      expect(cur.name).toBe(expected);
      cur = (cur.children as Array<{ name: string; children?: unknown[] }>)[0]!;
    }
    // The 5th level entry exists but has no expanded `children`.
    expect(cur.name).toBe("d5");
    expect(cur.children).toBeUndefined();
  });

  it("returns 403 for an unregistered project", async () => {
    unregisterProjectPath(project);
    const res = await fetch(`${baseUrl}/${encoded}/tree`);
    expect(res.status).toBe(403);
  });
});
