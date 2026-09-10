import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { FrozenSubmission } from "../../schemas/index.js";
import { assertParticipantSafePath } from "../core/utils.js";

export interface FixtureExport { readonly sourceRoot: string; readonly destinationRoot: string; readonly include: readonly string[]; readonly maxBytes: number; }
const excluded = new Set([".git", ".svn"]);

/** Copies only explicitly allowlisted public files, refusing links and special files. */
export async function exportPublicFixture(exportSpec: FixtureExport): Promise<void> {
  const source = await realpath(exportSpec.sourceRoot);
  const destination = resolve(exportSpec.destinationRoot);
  if (isWithin(source, destination) || isWithin(destination, source)) throw new Error("fixture source and destination must not overlap");
  await mkdir(destination, { recursive: true });
  if ((await lstat(destination)).isSymbolicLink()) throw new Error("destination symlink rejected");
  if (await realpath(destination) !== destination) throw new Error("destination ancestor symlink rejected");
  let total = 0;
  for (const publicPath of exportSpec.include) {
    assertParticipantSafePath(publicPath);
    const from = resolve(source, publicPath);
    if (!isWithin(source, from)) throw new Error(`fixture path escapes source: ${publicPath}`);
    const target = resolve(destination, publicPath);
    total += await copySafe(from, target, source, exportSpec.maxBytes - total);
  }
  if (total > exportSpec.maxBytes) throw new Error("public fixture exceeds storage limit");
}

/** Produces a content-addressed immutable submission manifest after all writers have stopped. */
export async function freezeSubmission(root: string, maxBytes: number, selection?: { include: readonly string[]; exclude: readonly string[] }): Promise<FrozenSubmission> {
  if ((await lstat(root)).isSymbolicLink()) throw new Error("submission root symlink rejected");
  const canonicalRoot = await realpath(root); const files: FrozenSubmission["files"] = []; let total = 0;
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const full = resolve(directory, entry.name); const rel = relative(canonicalRoot, full).split(sep).join("/");
      const info = await lstat(full);
      if (info.isSymbolicLink()) throw new Error(`submission contains symlink: ${rel}`);
      if (info.isDirectory()) await visit(full);
      else if (info.isFile()) { if (selection && (!selection.include.some(pattern => matches(pattern,rel)) || selection.exclude.some(pattern => matches(pattern,rel)))) continue; total += info.size; if (total > maxBytes) throw new Error("submission exceeds storage limit"); const data = await readFile(full); files.push({ path: rel, digest: digest(data), bytes: data.length, mode: info.mode & 0o777 }); }
      else throw new Error(`submission contains unsupported file type: ${rel}`);
    }
  }
  await visit(canonicalRoot); files.sort((a, b) => a.path.localeCompare(b.path));
  const rootDigest = digest(JSON.stringify(files));
  return { schemaVersion: 1, submissionHash: rootDigest, rootDigest, files, capturedAt: new Date().toISOString() };
}

/** Copies the verified submission into a newly-written directory, then atomically publishes it. */
export async function snapshotSubmission(root: string, destination: string, maxBytes: number, selection?: { include: readonly string[]; exclude: readonly string[] }): Promise<FrozenSubmission> {
  const source = await realpath(root); const target = resolve(destination);
  if (isWithin(source, target) || isWithin(target, source)) throw new Error("submission snapshot destination must not overlap source");
  // Validate before touching a prior published snapshot; never publish a partial tree.
  const manifest = await freezeSubmission(source, maxBytes, selection);
  const temporary = `${target}.partial-${process.pid}-${Date.now()}`;
  await rm(temporary, { recursive: true, force: true });
  await exportPublicFixture({ sourceRoot: source, destinationRoot: temporary, include: manifest.files.map(file => file.path), maxBytes });
  const copied = await freezeSubmission(temporary, maxBytes);
  if (copied.submissionHash !== manifest.submissionHash) { await rm(temporary, { recursive: true, force: true }); throw new Error("submission changed during snapshot"); }
  try { await lstat(target); throw new Error("snapshot already exists"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  await rename(temporary, target);
  return copied;
}

async function copySafe(source: string, target: string, allowedRoot: string, remaining: number): Promise<number> {
  if (!isWithin(allowedRoot, await realpath(source))) throw new Error("public fixture ancestor symlink escape");
  try { const targetInfo = await lstat(target); if (targetInfo.isSymbolicLink()) throw new Error("destination symlink rejected"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const info = await lstat(source); if (info.isSymbolicLink()) throw new Error(`public fixture contains symlink: ${source}`);
  if (info.isDirectory()) { let bytes = 0; await mkdir(target, { recursive: true, mode: info.mode & 0o777 }); for (const item of await readdir(source)) { if (excluded.has(item)) continue; bytes += await copySafe(resolve(source, item), resolve(target, item), allowedRoot, remaining - bytes); } return bytes; }
  if (!info.isFile()) throw new Error(`public fixture contains unsupported file: ${source}`);
  if (info.size > remaining) throw new Error("public fixture exceeds storage limit");
  await mkdir(dirname(target), { recursive: true }); await cp(source, target, { dereference: false }); return info.size;
}
function digest(input: string | Buffer): string { return createHash("sha256").update(input).digest("hex"); }
function isWithin(root: string, target: string): boolean { const path = relative(root, target); return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path)); }

function matches(pattern: string, path: string): boolean {
  assertParticipantSafePath(pattern);
  let expression = "";
  for (let i=0;i<pattern.length;i++) { const c=pattern[i]!; if (c==="*" && pattern[i+1]==="*") { i++; if(pattern[i+1]==="/"){i++;expression+="(?:.*/)?";}else expression+=".*"; } else if(c==="*") expression+="[^/]*"; else if(c==="?") expression+="[^/]"; else expression+=c.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"); }
  return new RegExp("^"+expression+"$").test(path);
}

/** Execute the trusted builder, then validate every emitted path before materializing. */
export async function preparePublicFixture(task: import("../../schemas/index.js").TaskDefinition, sourceRoot: string, destinationRoot: string, seed: string): Promise<void> {
  const recipe = await import(pathToFileURL(resolve(sourceRoot, task.fixture.configFile)).href);
  if (typeof recipe.build !== 'function') throw new Error('fixture must export build(seed)');
  const built = await recipe.build(seed);
  if (built.schemaVersion !== 1 || built.taskId !== task.id || !built.files || typeof built.files !== 'object') throw new Error('invalid public fixture identity/files');
  const entries = Object.entries(built.files);
  let total = 0;
  for (const [name, content] of entries) {
    assertParticipantSafePath(name);
    if (!name || name === '.' || name.split(/[\\/]/).some(p => ['.git','ground-truth'].includes(p)) || typeof content !== 'string') throw new Error('invalid public fixture file');
    total += Buffer.byteLength(content);
  }
  if (total > task.submission.maxBytes) throw new Error('public fixture exceeds storage limit');
  await mkdir(destinationRoot,{recursive:true});
  if (await realpath(destinationRoot) !== resolve(destinationRoot)) throw new Error('fixture destination symlink rejected');
  for (const [name,content] of entries) {
    const target = resolve(destinationRoot,name);
    await mkdir(dirname(target),{recursive:true});
    if (!isWithin(await realpath(destinationRoot),await realpath(dirname(target)))) throw new Error('fixture destination escape');
    await writeFile(target,content as string,{flag:'wx'});
  }
}
