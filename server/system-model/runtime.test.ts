import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import type { WebSocketServer } from "ws";
import { createBus } from "../bus.ts";
import { writeSettings } from "../project-store.ts";
import { resolveSystemModelRuntime, systemModelStatus } from "./runtime.ts";
import { copyValidFixture, copyValidFixtureWithSurfaces } from "./load.test.ts";

describe("resolveSystemModelRuntime", () => {
  it("stays off when the project setting is off", () => {
    const project = copyValidFixture();
    writeSettings(project, { systemModel: "off" });
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const runtime = resolveSystemModelRuntime({
      cwd: project,
      worktreeInfo: null,
      sessionKey: "leader-1",
      bus,
    });
    expect(runtime.mode).toBe("off");
    expect(runtime.model).toBeNull();
  });

  it("loads when flag and manifest are present", () => {
    const project = copyValidFixture();
    writeSettings(project, { systemModel: "advisory" });
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const runtime = resolveSystemModelRuntime({
      cwd: project,
      worktreeInfo: null,
      sessionKey: "leader-1",
      bus,
    });
    expect(runtime.mode).toBe("advisory");
    expect(runtime.model?.objectsById.size).toBeGreaterThan(0);
  });

  it("degrades and emits system_model_error on load failure", () => {
    const project = copyValidFixture();
    fs.copyFileSync(
      path.resolve("tests/fixtures/system-model/bad-yaml/.systemmodel/capabilities/bad.yaml"),
      path.join(project, ".systemmodel/capabilities/bad.yaml"),
    );
    writeSettings(project, { systemModel: "advisory" });
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const emitted: unknown[] = [];
    bus.subscribe((envelope) => emitted.push(envelope));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const runtime = resolveSystemModelRuntime({
      cwd: project,
      worktreeInfo: null,
      sessionKey: "leader-1",
      bus,
    });

    expect(runtime.model).toBeNull();
    expect(runtime.loadErrors.length).toBeGreaterThan(0);
    expect(emitted.some((event) => (event as { type?: string }).type === "system_model_error")).toBe(true);
  });

  it("reports surface counts", () => {
    const project = copyValidFixtureWithSurfaces();
    writeSettings(project, { systemModel: "advisory" });
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const runtime = resolveSystemModelRuntime({
      cwd: project, worktreeInfo: null, sessionKey: "leader-1", bus,
    });
    expect(systemModelStatus(runtime).counts.surfaces).toBe(2);
  });
});
