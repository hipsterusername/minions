import { spawn } from "node:child_process";

const MAX_STDERR = 64 * 1024;

export interface JsonlRecord {
  raw: string;
  value?: unknown;
}

export interface JsonlCompletion {
  code: number;
  stderr: string;
}

/**
 * Spawn a CLI and stream LF-delimited JSON without readline's extra Unicode
 * separators. The generator return value carries the exit status and bounded
 * stderr so adapters can turn setup failures into a final normalized event.
 */
export async function* streamJsonlProcess(input: {
  executable: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal: AbortSignal;
  stdin?: string;
}): AsyncGenerator<JsonlRecord, JsonlCompletion> {
  let spawnErrorMessage = "";
  const child = spawn(input.executable, [...input.args], {
    cwd: input.cwd,
    env: input.env,
    shell: false,
    windowsHide: true,
    stdio: [input.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (input.stdin !== undefined) child.stdin?.end(input.stdin);
  const onAbort = (): void => { child.kill(); };
  input.signal.addEventListener("abort", onAbort, { once: true });

  let stderr = "";
  const childStderr = child.stderr;
  const childStdout = child.stdout;
  if (!childStderr || !childStdout) throw new Error("JSONL child process pipes were not created");
  childStderr.setEncoding("utf8");
  childStderr.on("data", (chunk: string) => {
    if (stderr.length < MAX_STDERR) stderr += chunk.slice(0, MAX_STDERR - stderr.length);
  });
  child.once("error", (error) => { spawnErrorMessage = error.message; });
  const completion = new Promise<number>((resolve) => {
    child.once("close", (code) => resolve(code ?? -1));
  });

  let pending = "";
  childStdout.setEncoding("utf8");
  try {
    for await (const chunk of childStdout) {
      pending += String(chunk);
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const raw = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (raw.trim()) yield parseRecord(raw);
        newline = pending.indexOf("\n");
      }
    }
    const raw = pending.replace(/\r$/, "");
    if (raw.trim()) yield parseRecord(raw);
    const code = await completion;
    if (spawnErrorMessage && !stderr.trim()) stderr = spawnErrorMessage;
    return { code, stderr: stderr.trim() };
  } finally {
    input.signal.removeEventListener("abort", onAbort);
  }
}

function parseRecord(raw: string): JsonlRecord {
  try {
    return { raw, value: JSON.parse(raw) };
  } catch {
    return { raw };
  }
}
