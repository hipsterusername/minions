import { safeId } from "../core/durable.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { CapabilityReport, IsolationSpec } from "../../schemas/index.js";
import type { IsolationBackend } from "../core/contracts.js";

export interface CommandResult { readonly code: number; readonly stdout: string; readonly stderr: string; }
export type Command = (command: string, args: readonly string[]) => Promise<CommandResult>;
export interface DockerIsolationOptions { readonly stateRoot: string; readonly command?: Command; }
interface DockerWorkspace { readonly workspaceId: string; readonly containerName: string; readonly mountPath: string; }
export interface DockerExecution { readonly code: number; readonly stdout: string; readonly stderr: string; }

/** Docker isolation uses a per-run writable workspace and no host sockets or broad mounts. */
export class DockerIsolationBackend implements IsolationBackend {
  readonly id = "docker"; readonly version = "1"; readonly #command: Command;
  constructor(readonly options: DockerIsolationOptions) { this.#command = options.command ?? runCommand; }
  async preflight(spec: IsolationSpec): Promise<CapabilityReport> {
    const probe = await this.#command("docker", ["version", "--format", "{{.Server.Version}}"]).catch((error: Error) => ({ code: 1, stdout: "", stderr: error.message }));
    const networkSupported = spec.networkPolicy === "none";
    const pinned = /^(?:sha256:[a-f0-9]{64}|.+@sha256:[a-f0-9]{64})$/.test(spec.imageDigest);
    const image = pinned && probe.code === 0 ? await this.#command('docker',['image','inspect',spec.imageDigest,'--format','{{.Id}}']) : {code:1,stdout:'',stderr:'image unavailable'};
    return { schemaVersion: 1, adapterId: this.id, adapterVersion: this.version, supported: probe.code === 0 && networkSupported && pinned && image.code === 0, capabilities: { controlled_isolation: probe.code === 0 && networkSupported, network_none: probe.code === 0, declared_only: false, descendant_stop: probe.code === 0 }, limitations: !pinned ? ["controlled execution requires imageDigest pinned as sha256:<64 hex> or repository@sha256:<64 hex>"] : probe.code !== 0 ? ["Docker daemon unavailable; controlled isolation cannot be claimed"] : networkSupported ? (image.code === 0 ? [] : ["pinned image unavailable locally; prepare it before planning"]) : ["declared_only network policy has no allowlist implementation and is rejected"], evidence: [probe.code === 0 ? `Docker server ${probe.stdout.trim()}` : probe.stderr.trim() || "Docker version probe failed"] };
  }
  async provision(spec: IsolationSpec): Promise<{ workspaceId: string; mountPath: string }> {
    if (spec.networkPolicy !== "none") throw new Error("Docker backend rejects declared_only until an explicit network allowlist is implemented");
    safeId(spec.runId); const workspaceId = spec.runId;
    const existing = await this.readHandle(workspaceId); if (existing) return existing; const mountPath = resolve(this.options.stateRoot, workspaceId, "workspace"); const containerName = `agent-evals-${workspaceId}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
    await mkdir(mountPath, { recursive: true });
    const result = await this.#command("docker", ["run", "--pull", "never", "--detach", "--name", containerName, "--network", "none", "--read-only", "--cap-drop", "ALL", "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, "--security-opt", "no-new-privileges", "--tmpfs", "/state:rw,nosuid,mode=1777,size=64m", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--pids-limit", "256", "--memory", String(spec.memoryBytes), "--cpus", String(spec.cpuLimit), "--mount", `type=bind,src=${mountPath},dst=/workspace`, "--workdir", "/workspace", spec.imageDigest, "sleep", "infinity"]);
    if (result.code !== 0) { await rm(resolve(this.options.stateRoot, workspaceId), { recursive: true, force: true }); throw new Error(`docker provision failed: ${result.stderr}`); }
    await writeFile(join(this.options.stateRoot, workspaceId, "handle.json"), JSON.stringify({ workspaceId, containerName, mountPath }));
    return { workspaceId, mountPath };
  }
  /** Execute the participant inside the managed container, never on the host.
   * The idle container is only a durable isolation handle between adapter
   * launch/recovery calls; participant work always enters through this method.
   */
  async execute(workspaceId: string, command: readonly string[], environment: Readonly<Record<string, string>> = {}): Promise<DockerExecution> {
    if (command.length === 0) throw new Error("Docker execution command is required");
    const handle = await this.readHandle(workspaceId);
    if (!handle) throw new Error(`unknown Docker workspace ${workspaceId}`);
    const envArgs = Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
    const result = await this.#command("docker", ["exec", "--workdir", "/workspace", ...envArgs, handle.containerName, ...command]);
    return result;
  }
  async teardown(workspaceId: string): Promise<void> { const handle = await this.readHandle(workspaceId); if (!handle) return; const removed = await this.#command("docker", ["rm", "--force", handle.containerName]); if (removed.code !== 0 && !/No such container/i.test(removed.stderr)) throw new Error("Docker teardown failed: " + removed.stderr); await rm(resolve(this.options.stateRoot, workspaceId), { recursive: true, force: true }); }
  async descriptor(workspaceId: string): Promise<{ kind: "docker"; containerName: string; workdir: string; stateRoot: string }> { const handle = await this.readHandle(workspaceId); if (!handle) throw new Error("unknown Docker workspace"); return { kind: "docker", containerName: handle.containerName, workdir: "/workspace", stateRoot: resolve(this.options.stateRoot, workspaceId, "supervisor") }; }
  async stopDescendants(workspaceId: string): Promise<void> { const handle = await this.readHandle(workspaceId); if (!handle) return; const result = await this.#command("docker", ["stop", "--time", "1", handle.containerName]); if (result.code !== 0 && !/No such container/i.test(result.stderr)) throw new Error(`docker stop failed: ${result.stderr}`); }
  private async readHandle(workspaceId: string): Promise<DockerWorkspace | null> { safeId(workspaceId); try { return JSON.parse(await readFile(join(this.options.stateRoot, workspaceId, "handle.json"), "utf8")) as DockerWorkspace; } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }
}
async function runCommand(command: string, args: readonly string[]): Promise<CommandResult> { return new Promise((resolveResult, reject) => { const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] }); let stdout = ""; let stderr = ""; child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; }); child.once("error", reject); child.once("close", (code) => resolveResult({ code: code ?? 1, stdout, stderr })); }); }
