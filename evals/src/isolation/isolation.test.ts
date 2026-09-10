import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DockerIsolationBackend, exportPublicFixture, freezeSubmission, LocalDevelopmentIsolationBackend, snapshotSubmission } from "./index.js";

describe("isolation boundaries", () => {
  it("exports only allowlisted public assets and rejects symlink attacks", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-fixture-")); const source = join(root, "source"); const output = join(root, "output"); await mkdir(join(source, "public"), { recursive: true }); await writeFile(join(source, "public", "prompt.md"), "public"); await writeFile(join(source, "oracle.txt"), "hidden");
    await exportPublicFixture({ sourceRoot: source, destinationRoot: output, include: ["public"], maxBytes: 100 }); expect(await readFile(join(output, "public", "prompt.md"), "utf8")).toBe("public");
    await symlink(join(source, "oracle.txt"), join(source, "public", "leak")); await expect(exportPublicFixture({ sourceRoot: source, destinationRoot: output, include: ["public"], maxBytes: 100 })).rejects.toThrow(/symlink/);
  });
  it("refuses symlink and traversal submissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-submission-")); await writeFile(join(root, "safe.txt"), "ok"); expect((await freezeSubmission(root, 100)).files[0]?.path).toBe("safe.txt"); await symlink("/etc/passwd", join(root, "escape")); await expect(freezeSubmission(root, 100)).rejects.toThrow(/symlink/);
  });
  it("atomically publishes a frozen snapshot after validating it", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-snapshot-")); const source = join(root, "source"); await mkdir(source); await writeFile(join(source, "answer.txt"), "42"); const snapshot = await snapshotSubmission(source, join(root, "snapshot"), 100);
    expect(await readFile(join(root, "snapshot", "answer.txt"), "utf8")).toBe("42"); expect(snapshot.files).toHaveLength(1);
  });
  it("makes Docker availability explicit and local backend never claims control", async () => {
    const docker = new DockerIsolationBackend({ stateRoot: await mkdtemp(join(tmpdir(), "eval-docker-")), command: async () => ({ code: 1, stdout: "", stderr: "daemon unavailable" }) }); const spec = { schemaVersion: 1 as const, backendId: "docker", runId: "run", participantRoot: "/fixture", networkPolicy: "none" as const, cpuLimit: 1, memoryBytes: 1024, storageBytes: 1024, imageDigest: "image@sha256:x" };
    expect((await docker.preflight(spec)).supported).toBe(false); const local = new LocalDevelopmentIsolationBackend(await mkdtemp(join(tmpdir(), "eval-local-"))); expect((await local.preflight(spec)).capabilities.controlled_isolation).toBe(false);
  });
  it("runs participant commands through the managed container rather than the host", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const root = await mkdtemp(join(tmpdir(), "eval-docker-exec-"));
    const docker = new DockerIsolationBackend({ stateRoot: root, command: async (command, args) => {
      calls.push({ command, args }); return { code: 0, stdout: "container-id", stderr: "" };
    } });
    const spec = { schemaVersion: 1 as const, backendId: "docker", runId: "run", participantRoot: "/fixture", networkPolicy: "none" as const, cpuLimit: 1, memoryBytes: 1024, storageBytes: 1024, imageDigest: "image@sha256:x" };
    const workspace = await docker.provision(spec);
    await docker.execute(workspace.workspaceId, ["sh", "-lc", "./participant.sh"], { SAFE: "1" });
    const exec = calls.find((call) => call.args[0] === "exec");
    expect(exec?.command).toBe("docker");
    expect(exec?.args).toEqual(expect.arrayContaining(["--workdir", "/workspace", "--env", "SAFE=1", "sh", "-lc", "./participant.sh"]));
  });
});
