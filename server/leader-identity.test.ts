import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionHost, type SessionHostDeps } from "./session-host.ts";
import { SessionRegistry } from "./session-registry.ts";

afterEach(() => vi.restoreAllMocks());

describe("Leader identity boundary", () => {
  it.each([undefined, "", " "])("rejects a Leader without identity (%s) before creating a host", (workItemId) => {
    const registry = new SessionRegistry(1);
    registry.setDeps({} as SessionHostDeps);
    expect(() => registry.start({ sessionKey: "leader", cwd: "/tmp", prompt: "go",
      role: "leader", workItemId })).toThrow("Leader requires a work-item identity");
    expect(registry.has("leader")).toBe(false);
    expect(registry.capacityCount()).toBe(0);
  });

  it("also rejects direct host starts and role promotion without identity", async () => {
    const host = new SessionHost("leader", "/tmp");
    await expect(host.start({ sessionKey: host.id, cwd: host.cwd,
      prompt: "go", role: "leader" }, {} as SessionHostDeps)).rejects.toThrow("work-item identity");
    host.role = "leader";
    await expect(host.start({ sessionKey: host.id, cwd: host.cwd,
      prompt: "resume" }, {} as SessionHostDeps)).rejects.toThrow("work-item identity");
    expect(host.status).not.toBe("running");
  });

  it("retains identity when a resume omits it and rejects attempts to replace it", () => {
    const registry = new SessionRegistry();
    registry.setDeps({} as SessionHostDeps);
    const start = vi.spyOn(SessionHost.prototype, "start").mockResolvedValue();
    registry.start({ sessionKey: "leader", cwd: "/tmp", prompt: "go", role: "leader", workItemId: "work-1" });
    const host = registry.get("leader")!;
    // Model the state established by the first real host invocation.
    host.role = "leader";
    host.workItemId = "work-1";
    registry.start({ sessionKey: "leader", cwd: "/tmp", prompt: "resume", invocationKind: "provider_continuation" });
    expect(start).toHaveBeenCalledTimes(2);
    for (const workItemId of ["work-2", ""]) {
      expect(() => registry.start({ sessionKey: "leader", cwd: "/tmp", prompt: "resume", workItemId }))
        .toThrow(/identity/);
    }
    expect(host.workItemId).toBe("work-1");
    expect(start).toHaveBeenCalledTimes(2);
  });
});
