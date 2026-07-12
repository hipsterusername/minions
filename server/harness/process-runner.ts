import { execFile } from "node:child_process";

export interface ProcessResult { code: number; stdout: string }
export type ProcessRunner = (
  executable: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; signal: AbortSignal },
) => Promise<ProcessResult>;

const MAX_CAPTURE = 16_384;

export const runProcess: ProcessRunner = (executable, args, options) =>
  new Promise((resolve, reject) => {
    execFile(executable, [...args], {
      env: options.env,
      signal: options.signal,
      shell: false,
      encoding: "utf8",
      maxBuffer: MAX_CAPTURE,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        const code = typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
          ? (error as unknown as { code: number }).code
          : -1;
        if ((error as Error).name === "AbortError") reject(error);
        else resolve({ code, stdout: String(stdout).slice(0, MAX_CAPTURE) });
        return;
      }
      resolve({ code: 0, stdout: String(stdout).slice(0, MAX_CAPTURE) });
    });
  });
