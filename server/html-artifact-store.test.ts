import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  deleteHtmlArtifactsForSession,
  htmlArtifactsRoot,
  sweepOrphanHtmlArtifacts,
  writeHtmlArtifact,
} from "./html-artifact-store.ts";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "minions-artifacts-"));
  process.env.MINIONS_ARTIFACTS_DIR = tmpRoot;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.MINIONS_ARTIFACTS_DIR;
});

describe("writeHtmlArtifact", () => {
  it("defaults to the MINIONS_HOME state collection", () => {
    delete process.env.MINIONS_ARTIFACTS_DIR;
    process.env.MINIONS_HOME = tmpRoot;
    try {
      expect(htmlArtifactsRoot()).toBe(path.join(tmpRoot, "artifacts", "html"));
    } finally {
      delete process.env.MINIONS_HOME;
      process.env.MINIONS_ARTIFACTS_DIR = tmpRoot;
    }
  });

  it("creates the file with metadata when an id is omitted", async () => {
    const html = "<!doctype html><p>Hello</p>";
    const meta = await writeHtmlArtifact("session-1", { html, title: "Greeting" });

    expect(meta.id).toMatch(/^[a-f0-9]{16}$/);
    expect(meta.sessionKey).toBe("session-1");
    expect(meta.title).toBe("Greeting");
    expect(meta.createdAt).toBeGreaterThan(0);
    expect(meta.bytes).toBe(Buffer.byteLength(html, "utf8"));
    expect(meta.path.startsWith(`${path.resolve(htmlArtifactsRoot())}${path.sep}`)).toBe(true);
    expect(readFileSync(meta.path, "utf8")).toBe(html);
  });

  it("uses a provided id", async () => {
    const html = "<h1>Chosen</h1>";
    const meta = await writeHtmlArtifact("session_2", { id: "published.page", html });

    expect(meta.id).toBe("published.page");
    expect(meta.path).toBe(path.join(await realpath(htmlArtifactsRoot()), "c2Vzc2lvbl8y--published.page.html"));
    expect(readFileSync(meta.path, "utf8")).toBe(html);
    expect(meta.bytes).toBe(Buffer.byteLength(html, "utf8"));
  });

  it("ignores a legacy symlinked session directory without writing outside", async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), "artifact-outside-"));
    symlinkSync(outside, path.join(htmlArtifactsRoot(), "linked-session"), "junction");
    try {
      await expect(writeHtmlArtifact("linked-session", { id: "escape", html: "bad" }))
        .resolves.toMatchObject({ sessionKey: "linked-session" });
      expect(existsSync(path.join(outside, "escape.html"))).toBe(false);
    } finally {
      rmSync(path.join(htmlArtifactsRoot(), "linked-session"), { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a pre-existing flat artifact symlink without changing its target", async () => {
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), "artifact-file-outside-"));
    const outside = path.join(outsideDir, "outside.html");
    writeFileSync(outside, "keep me");
    const artifactPath = path.join(htmlArtifactsRoot(), "c2FmZS1zZXNzaW9u--linked.html");
    symlinkSync(outside, artifactPath);
    try {
      await expect(writeHtmlArtifact("safe-session", { id: "linked", html: "overwrite" }))
        .rejects.toThrow();
      expect(readFileSync(outside, "utf8")).toBe("keep me");
    } finally {
      rmSync(artifactPath, { force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("deleteHtmlArtifactsForSession", () => {
  it("removes all flat artifacts for the session", async () => {
    const meta = await writeHtmlArtifact("to-delete", { id: "one", html: "<p>Bye</p>" });
    await deleteHtmlArtifactsForSession("to-delete");
    expect(existsSync(meta.path)).toBe(false);
  });

  it("does not throw when the session dir does not exist", async () => {
    await expect(deleteHtmlArtifactsForSession("missing-session")).resolves.toBeUndefined();
  });

  it("rejects a symlinked session directory instead of deleting its target", async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), "artifact-delete-outside-"));
    writeFileSync(path.join(outside, "keep.txt"), "keep");
    symlinkSync(outside, path.join(htmlArtifactsRoot(), "linked-delete"), "junction");
    try {
      await expect(deleteHtmlArtifactsForSession("linked-delete")).rejects.toThrow(/real contained/);
      expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
    } finally {
      rmSync(path.join(htmlArtifactsRoot(), "linked-delete"), { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("sweepOrphanHtmlArtifacts", () => {
  it("removes unknown session dirs, keeps known ones, and ignores files", async () => {
    await mkdir(path.join(htmlArtifactsRoot(), "known"), { recursive: true });
    await mkdir(path.join(htmlArtifactsRoot(), "orphan-a"), { recursive: true });
    await mkdir(path.join(htmlArtifactsRoot(), "orphan-b"), { recursive: true });
    writeFileSync(path.join(htmlArtifactsRoot(), "loose-file"), "not a session");

    const removed = await sweepOrphanHtmlArtifacts(["known"]);

    expect(removed).toBe(2);
    expect(existsSync(path.join(htmlArtifactsRoot(), "known"))).toBe(true);
    expect(existsSync(path.join(htmlArtifactsRoot(), "orphan-a"))).toBe(false);
    expect(existsSync(path.join(htmlArtifactsRoot(), "orphan-b"))).toBe(false);
    expect(existsSync(path.join(htmlArtifactsRoot(), "loose-file"))).toBe(true);
  });

  it("returns 0 when the root is absent", async () => {
    rmSync(htmlArtifactsRoot(), { recursive: true, force: true });

    await expect(sweepOrphanHtmlArtifacts(["known"])).resolves.toBe(0);
  });
});

describe("path safety", () => {
  const badSessionKeys = ["../evil", "..", ".", "a/b", ""];

  it.each(badSessionKeys)("rejects unsafe sessionKey %j on write", async (sessionKey) => {
    await expect(writeHtmlArtifact(sessionKey, { html: "<p>x</p>" })).rejects.toThrow(
      `unsafe artifact segment: ${sessionKey}`,
    );
  });

  it.each(badSessionKeys)("rejects unsafe sessionKey %j on delete", async (sessionKey) => {
    await expect(deleteHtmlArtifactsForSession(sessionKey)).rejects.toThrow(
      `unsafe artifact segment: ${sessionKey}`,
    );
  });

  it("rejects a bad id", async () => {
    await expect(writeHtmlArtifact("safe-session", { id: "../evil", html: "<p>x</p>" })).rejects.toThrow(
      "unsafe artifact segment: ../evil",
    );
  });
});
