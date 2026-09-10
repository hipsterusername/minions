import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
export function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
export async function locked<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const lock = path + ".lock";
  for (let attempt = 0; ; attempt++) {
    try { const file = await open(lock, "wx", 0o600); await file.writeFile(String(process.pid)); await file.close(); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(await readFile(lock, "utf8").catch(() => "0"));
      if (owner > 0 && !alive(owner)) { await rm(lock, { force: true }); continue; }
      if (attempt > 500) throw new Error("state lock busy: " + path);
      await delay(10);
    }
  }
  try { return await action(); } finally { await rm(lock, { force: true }); }
}
export function safeId(id: string): string { if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(id) || id === "." || id === "..") throw new Error("unsafe identity"); return id; }
