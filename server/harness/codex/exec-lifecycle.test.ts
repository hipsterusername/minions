import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedEvent } from "../types.ts";

const fixture = vi.hoisted(() => ({ executable: "" }));
vi.mock("./runtime.ts", () => ({
  resolveCodexRuntime: () => ({ executable: fixture.executable }),
  checkCodexReadiness: vi.fn(),
}));
vi.mock("./auth.ts", () => ({ resolveCodexCredentials: () => ({}) }));
// Exercise the installed SDK and a local fixture process, never a real Codex
// invocation or user credentials. All state stays in the fixture directory.
vi.mock("./env.ts", () => ({ buildCodexEnv: () => ({ PATH: process.env["PATH"] ?? "" }) }));

import { codexHarness } from "./index.ts";

let fixtureDir: string | undefined;
afterEach(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

// The executable fixture uses a POSIX shebang; Windows cleanup behavior is
// covered by the adapter's event-stream regression tests.
describe.skipIf(process.platform === "win32")("Codex installed SDK process boundary", () => {
  it.each(["recovered", "failed"] as const)(
    "publishes %s only after the CLI writer process exits", async (outcome) => {
      fixtureDir = await mkdtemp(join(tmpdir(), "minions-codex-exit-"));
      fixture.executable = join(fixtureDir, "fixture-cli.cjs");
      const pidPath = join(fixtureDir, "pid");
      const cliEvents = [
        { type: "thread.started", thread_id: "fixture-thread" },
        { type: "error", message: "Reconnecting... 2/5 (stream disconnected before completion: websocket closed by server before response.completed)" },
        ...(outcome === "recovered" ? [
          { type: "item.completed", item: { id: "final", type: "agent_message", text: "Recovered" } },
          { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } },
        ] : [{ type: "turn.failed", error: { message: "Retries exhausted" } }]),
      ];
      await writeFile(fixture.executable, [
        `#!${process.execPath}`,
        `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        "process.stdin.resume();",
        `for (const event of ${JSON.stringify(cliEvents)}) require("node:fs").writeSync(1, JSON.stringify(event) + "\\n");`,
        // Keep the writer alive after publishing its final JSONL event.
        `setTimeout(() => process.exit(${outcome === "failed" ? 1 : 0}), 150);`,
      ].join("\n") + "\n", { mode: 0o755 });
      const { events, control } = codexHarness.start({ sessionKey: "fixture", cwd: fixtureDir,
        prompt: "local fixture", systemPrompt: "fixture", model: "fixture", allowedTools: [], abortSignal: new AbortController().signal });
      const out: NormalizedEvent[] = [];
      try {
        for await (const event of events) {
          if (event.kind === "done") {
            const pid = Number(await readFile(pidPath, "utf8"));
            expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
          }
          out.push(event);
        }
      } finally {
        control.abort();
      }
      expect(out.filter((event) => event.kind === "done"), JSON.stringify(out)).toEqual([
        expect.objectContaining({ kind: "done", reason: outcome === "recovered" ? "completed" : "error" }),
      ]);
      expect(out[1]).toMatchObject({ kind: "api_retry", attempt: 2 });
      if (outcome === "failed") {
        expect(out.at(-1)).toMatchObject({ error: "Retries exhausted", fullError: expect.stringContaining("Codex Exec exited with code 1") });
      }
    },
  );
});
