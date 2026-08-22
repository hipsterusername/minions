import { describe, expect, it, vi } from "vitest";
import "./harness/register-production.ts";
import { launchSession, SessionLaunchError } from "./session-launch.ts";
import type { SessionRegistry } from "./session-registry.ts";
import type { SessionCapacityReservation } from "./session-registry.ts";
import type { Bus } from "./bus.ts";
import type { HarnessReadinessSnapshot } from "./harness/readiness-types.ts";

function snapshot(readyHarnesses: string[]): HarnessReadinessSnapshot {
  return { schemaVersion: 1, checkedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:00:30.000Z", ready: readyHarnesses.length > 0, readyHarnesses, harnesses: [] };
}

function setup() {
  const starts: unknown[] = [];
  const events: unknown[] = [];
  const registry = {
    has: () => false,
    reserveCapacity: (sessionKey: string): SessionCapacityReservation => ({ sessionKey, token: null }),
    releaseCapacity: vi.fn(),
    start: (options: unknown) => starts.push(options),
  } as unknown as SessionRegistry;
  const bus = { emitToSession: (_key: string, event: unknown) => events.push(event) } as unknown as Bus;
  return { registry, bus, starts, events };
}

describe("launchSession", () => {
  it("switches an unavailable harness without carrying its model", async () => {
    const h = setup();
    const result = await launchSession({
      registry: h.registry, bus: h.bus,
      options: { sessionKey: "s1", cwd: "/work", prompt: "hello", role: "leader", harness: "claude", initialModel: "claude-opus-4-8", permissionMode: "plan" },
      getReadiness: vi.fn(async () => snapshot(["codex"])),
    });
    expect(result).toMatchObject({ harness: "codex", model: "gpt-5.6-sol", permissionMode: "plan", reasons: ["harness_not_ready", "model_incompatible"] });
    expect(h.events[0]).toMatchObject({ type: "session_launch_resolved", transient: true });
    expect(h.starts[0]).toMatchObject({ harness: "codex", initialModel: "gpt-5.6-sol", permissionMode: "plan" });
  });

  it("rejects before creating a host when no harness is ready", async () => {
    const h = setup();
    await expect(launchSession({ registry: h.registry, bus: h.bus, options: { sessionKey: "s1", cwd: "/work", prompt: "hello" }, getReadiness: vi.fn(async () => snapshot([])) })).rejects.toBeInstanceOf(SessionLaunchError);
    expect(h.starts).toEqual([]);
  });

  it("holds a capacity reservation across asynchronous readiness", async () => {
    let releaseReadiness!: () => void;
    const readinessGate = new Promise<void>((resolve) => { releaseReadiness = resolve; });
    const reservations = new Set<symbol>();
    const registry = {
      has: () => false,
      reserveCapacity: (sessionKey: string): SessionCapacityReservation => {
        if (reservations.size >= 1) {
          throw new Error("capacity exhausted");
        }
        const token = Symbol(sessionKey);
        reservations.add(token);
        return { sessionKey, token };
      },
      releaseCapacity: (reservation: SessionCapacityReservation) => {
        if (reservation.token) reservations.delete(reservation.token);
      },
      start: (_options: unknown, reservation: SessionCapacityReservation) => {
        if (reservation.token) reservations.delete(reservation.token);
      },
    } as unknown as SessionRegistry;
    const bus = { emitToSession: vi.fn() } as unknown as Bus;
    const first = launchSession({
      registry,
      bus,
      options: { sessionKey: "s1", cwd: "/work", prompt: "hello" },
      getReadiness: vi.fn(async () => {
        await readinessGate;
        return snapshot(["claude"]);
      }),
    });

    expect(reservations.size).toBe(1);
    await expect(launchSession({
      registry,
      bus,
      options: { sessionKey: "s2", cwd: "/work", prompt: "hello" },
      getReadiness: vi.fn(async () => snapshot(["claude"])),
    })).rejects.toThrow("capacity exhausted");

    releaseReadiness();
    await first;
    expect(reservations.size).toBe(0);
  });
});
