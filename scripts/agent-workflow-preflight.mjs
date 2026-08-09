#!/usr/bin/env node

/**
 * Preflight for delegating code edits to another agent/minion.
 *
 * This intentionally does not mutate git state. It verifies that the leader
 * can see and write git metadata, and that dirty work has an explicit
 * checkpoint label before anyone hands code-edit ownership to another agent.
 */
import { execFileSync } from "node:child_process";
import { existsSync, openSync, closeSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const args = new Set(process.argv.slice(2));
const checkpointArgIndex = process.argv.indexOf("--checkpoint");
const checkpoint =
  checkpointArgIndex >= 0 ? process.argv[checkpointArgIndex + 1] : process.env["AGENT_CHECKPOINT"];
const allowDirty = args.has("--allow-dirty");

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fail(message) {
  console.error(`agent workflow preflight failed: ${message}`);
  process.exitCode = 1;
}

function listFiles(root, predicate) {
  const out = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (predicate(full)) {
        out.push(relative(root, full).replace(/\\/g, "/"));
      }
    }
  }
  walk(root);
  return out;
}

let root;
try {
  root = git(["rev-parse", "--show-toplevel"]);
} catch {
  fail("not inside a git repository");
  process.exit();
}

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch === "HEAD") {
  fail("HEAD is detached; create or switch to a named branch before delegation");
}

const gitDir = git(["rev-parse", "--git-dir"]);
const gitPath = gitDir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(gitDir) ? gitDir : join(root, gitDir);

if (existsSync(join(gitPath, "index.lock"))) {
  fail(".git/index.lock already exists; resolve the interrupted git operation first");
}

const metadataProbe = join(gitPath, "minions-agent-preflight.tmp");
try {
  const fd = openSync(metadataProbe, "wx");
  closeSync(fd);
  unlinkSync(metadataProbe);
} catch (err) {
  fail(`git metadata is not writable (${err instanceof Error ? err.message : String(err)})`);
}

const rejects = listFiles(root, (file) => file.endsWith(".rej"));
if (rejects.length > 0) {
  fail(`reject files remain from a failed patch: ${rejects.slice(0, 8).join(", ")}`);
}

const status = git(["status", "--porcelain"]);
const changed = status ? status.split(/\r?\n/).filter(Boolean) : [];
if (changed.length > 0 && !allowDirty && !checkpoint) {
  fail(
    "working tree is dirty and no checkpoint was declared. " +
      "Commit, stash, or create a patch backup, then rerun with --checkpoint <label>.",
  );
}

if (process.exitCode) process.exit();

console.log(`agent workflow preflight passed on ${branch}`);
if (changed.length > 0) {
  console.log(`dirty entries: ${changed.length}`);
  console.log(`checkpoint: ${checkpoint ?? "allowed dirty by flag"}`);
}
