import type { GitIntegrationResult } from "./git-integration-types.ts";

export interface GitIntegrationPumpWorker {
  runNext(repositoryPath: string, targetRef: string): Promise<GitIntegrationResult | null>;
}
export interface GitIntegrationPumpOptions {
  retryDelayMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  onError?: (error: unknown, repositoryPath: string, targetRef: string) => void;
}

/** FIFO scope pump that stops and backs off when the head entry must wait. */
export function createGitIntegrationPump(worker: GitIntegrationPumpWorker,
  options: GitIntegrationPumpOptions = {}) {
  const active = new Set<string>();
  const timers = new Map<string, number | ReturnType<typeof setTimeout>>();
  const retryDelay = options.retryDelayMs ?? 5_000;
  const setTimer = options.setTimer ?? setTimeout;
  const keyOf = (repo: string, ref: string) => `${repo}\0${ref}`;
  const notify = (repositoryPath: string, targetRef: string) => {
    const key = keyOf(repositoryPath, targetRef);
    if (active.has(key) || timers.has(key)) return;
    active.add(key);
    void (async () => {
      while (true) {
        const result = await worker.runNext(repositoryPath, targetRef);
        if (!result) return;
        if (result.status === "waiting") {
          active.delete(key);
          const timer = setTimer(() => { timers.delete(key); notify(repositoryPath, targetRef); }, retryDelay);
          if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
          timers.set(key, timer); return;
        }
      }
    })().catch((error) => options.onError?.(error, repositoryPath, targetRef))
      .finally(() => active.delete(key));
  };
  return { notify, shutdown() { for (const timer of timers.values())
    clearTimeout(timer as ReturnType<typeof setTimeout>);
    timers.clear(); active.clear(); } };
}
