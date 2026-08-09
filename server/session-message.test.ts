/**
 * injectSessionMessage — resumes a live/idle session with the steering message
 * and reports non-delivery for ended or unknown sessions. Mocks at the deps
 * boundary (getSessionRuntime / startChildSession).
 */
import { describe, expect, it } from "vitest";
import { injectSessionMessage } from "./session-message.ts";
import type { SessionHostDeps } from "./session-host.ts";
import type { RuntimeSessionInfo } from "./task-tools.ts";
import type { StartSessionOptions } from "./session-host.ts";

function runtime(over: Partial<RuntimeSessionInfo> = {}): RuntimeSessionInfo {
  return {
    sessionKey: "m-1",
    sessionId: "sid-1",
    status: "idle",
    role: "minion",
    cwd: "/proj",
    model: null,
    harness: "claude",
    totalCost: 0,
    turns: 1,
    isLive: false,
    lastActivityAt: null,
    lastActivityAgeMs: null,
    lastEventType: null,
    lastSdkEventKind: null,
    lastError: null,
    lastErrorFull: null,
    ...over,
  };
}

function makeDeps(rt: RuntimeSessionInfo | null): {
  deps: SessionHostDeps;
  started: StartSessionOptions[];
} {
  const started: StartSessionOptions[] = [];
  const deps = {
    getSessionRuntime: () => rt,
    startChildSession: (opts: StartSessionOptions) => {
      started.push(opts);
    },
  } as unknown as SessionHostDeps;
  return { deps, started };
}

describe("injectSessionMessage", () => {
  it("resumes an idle session with the message as the prompt", () => {
    const { deps, started } = makeDeps(runtime({ status: "idle" }));
    const result = injectSessionMessage(deps, "m-1", "redirect please");

    expect(result).toEqual({ delivered: true, status: "idle" });
    expect(started).toHaveLength(1);
    expect(started[0]!.sessionKey).toBe("m-1");
    expect(started[0]!.prompt).toBe("redirect please");
    expect(started[0]!.resumeId).toBe("sid-1");
    expect(started[0]!.invocationKind).toBe("resume_open_run");
  });

  it("does NOT deliver to a running session because start() would drop the resume", () => {
    const { deps, started } = makeDeps(runtime({ status: "running" }));
    const result = injectSessionMessage(deps, "m-1", "hi");
    expect(result).toEqual({ delivered: false, status: "running" });
    expect(started).toHaveLength(0);
  });

  it("does not deliver to an ended session and names the status", () => {
    const { deps, started } = makeDeps(runtime({ status: "completed" }));
    const result = injectSessionMessage(deps, "m-1", "too late");
    expect(result).toEqual({ delivered: false, status: "completed" });
    expect(started).toHaveLength(0);
  });

  it("does not deliver when the session is unknown", () => {
    const { deps, started } = makeDeps(null);
    const result = injectSessionMessage(deps, "ghost", "x");
    expect(result).toEqual({ delivered: false, status: null });
    expect(started).toHaveLength(0);
  });

  it("routes a bound child through the canonical continuation seam", () => {
    const { deps, started } = makeDeps(runtime({ workItemId: "work-1", runKey: "run-1", runKind: "child" }));
    const continued: unknown[] = [];
    deps.continueWorkItemChild = (input) => { continued.push(input); };
    expect(injectSessionMessage(deps, "m-1", "continue").delivered).toBe(true);
    expect(continued).toHaveLength(1);
    expect(continued[0]).toMatchObject({ workItemId: "work-1", runKey: "run-1", prompt: "continue" });
    expect(started).toHaveLength(0);
  });
});
