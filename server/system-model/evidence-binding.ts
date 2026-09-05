import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { workPacketSchema, type WorkPacket } from "../../shared/system-model/index.ts";
import type { LoadedSystemModel } from "./types.ts";

const execute = promisify(execFile);
export function evidenceHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** No metadata-only fallback: an unreadable repository cannot supply merge evidence. */
export async function captureEvidenceBinding(cwd: string, packet: WorkPacket,
  model: LoadedSystemModel | null, baseCwd = cwd): Promise<string> {
  packet = workPacketSchema.parse(packet);
  const git = async (...args: string[]) => (await execute("git", args,
    { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout;
  const head = (await git("rev-parse", "HEAD")).trim();
  const baseHead = (await execute("git", ["rev-parse", "HEAD"], { cwd: baseCwd })).stdout.trim();
  const contents = await captureContents(cwd);
  if ((await git("rev-parse", "HEAD")).trim() !== head) throw new Error("Repository changed during evidence capture");
  if ((await execute("git", ["rev-parse", "HEAD"], { cwd: baseCwd })).stdout.trim() !== baseHead)
    throw new Error("Baseline changed during evidence capture");
  return evidenceHash({ version: 2, baseHead, contents, policies: model?.policies,
    packet: { id: packet.id, scope: packet.scope, amendments: packet.amendments,
      riskLevel: packet.riskLevel, required: packet.freshness.requiredVerifications.map(({ kind, target }) => ({ kind, target })) } });
}

async function captureContents(cwd: string): Promise<Array<[string, string, string]>> {
  const git = async (...args: string[]) => (await execute("git", args,
    { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout;
  const files = [...new Set((await git("ls-files", "--cached", "--others", "--exclude-standard", "-z"))
    .split("\0").filter(Boolean))].sort();
  const contents: Array<[string, string, string]> = [];
  for (const file of files) {
    const absolute = path.join(cwd, file);
    let stat;
    try { stat = await lstat(absolute); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (stat.isDirectory()) {
      const top = (await execute("git", ["rev-parse", "--show-toplevel"], { cwd: absolute })).stdout.trim();
      if (await realpath(top) !== await realpath(absolute)) throw new Error(`Unavailable submodule or nested repository ${file}`);
      const head = (await execute("git", ["rev-parse", "HEAD"], { cwd: absolute })).stdout.trim();
      contents.push([file.replace(/\/$/, ""), "gitlink", evidenceHash({ head, contents: await captureContents(absolute) })]);
      continue;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Cannot bind evidence for non-file ${file}`);
    const bytes = stat.isSymbolicLink() ? await readlink(absolute) : await readFile(absolute);
    contents.push([file, stat.isSymbolicLink() ? "symlink" : (stat.mode & 0o111) ? "executable" : "file",
      createHash("sha256").update(bytes).digest("hex")]);
  }
  return contents;
}
