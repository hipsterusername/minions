import { describe, expect, it, vi } from "vitest";
import type { NormalizedEvent } from "../shared/normalized-event.ts";
import type { Bus } from "./bus.ts";
import type { AgentType, AgentTypeContext } from "./agents/types.ts";
import type { SessionHost } from "./session-host.ts";
import { processNormalizedEvent } from "./session-host-run.ts";
import {
  emitMutationToolObservation,
  observeMutationToolCall,
} from "./mutation-observability.ts";

function call(name: string, input: unknown = {}): Extract<NormalizedEvent, { kind: "tool_call" }> {
  return { kind: "tool_call", id: "call-1", name, input };
}

describe("observeMutationToolCall", () => {
  it.each(["Write", "Edit"])("extracts a Claude %s target", (name) => {
    expect(observeMutationToolCall("claude", call(name, { file_path: " src/app.ts " }))).toEqual({
      harness: "claude",
      toolName: name,
      coverage: "extracted",
      potentiallyMutating: true,
      descriptor: { operation: "write", paths: ["src/app.ts"], opaque: false },
    });
  });

  it("does not claim extraction when a known file tool omits its path", () => {
    expect(observeMutationToolCall("claude", call("Write"))).toMatchObject({
      coverage: "opaque",
      descriptor: { operation: "write", paths: [], opaque: true },
    });
  });

  it.each([
    ["claude", "Bash", "shell"],
    ["codex", "codex_command", "shell"],
    ["codex", "codex_file_change", "write"],
  ])("marks %s/%s as an opaque mutation", (harness, name, operation) => {
    expect(observeMutationToolCall(harness, call(name))).toMatchObject({
      coverage: "opaque",
      potentiallyMutating: true,
      descriptor: { operation, paths: [], opaque: true },
    });
  });

  it("extracts generic write/delete/rename/patch routes", () => {
    expect(observeMutationToolCall("claude", call("mcp__files__write_file",
      { path: "src/new.ts" }))).toMatchObject({
      coverage: "extracted", descriptor: { operation: "write", paths: ["src/new.ts"] },
    });
    expect(observeMutationToolCall("claude", call("delete_file",
      { path: "src/old.ts" }))).toMatchObject({
      descriptor: { operation: "delete", paths: ["src/old.ts"] },
    });
    expect(observeMutationToolCall("claude", call("rename_file",
      { from_path: "a.ts", to_path: "b.ts" }))).toMatchObject({
      descriptor: { operation: "rename", paths: ["a.ts", "b.ts"] },
    });
    expect(observeMutationToolCall("claude", call("apply_patch", { patch:
      "*** Begin Patch\n*** Update File: src/a.ts\n*** Delete File: src/b.ts\n*** End Patch" })))
      .toMatchObject({ descriptor: { operation: "write", paths: ["src/a.ts", "src/b.ts"] } });
  });

  it("distinguishes known reads and coordination tools", () => {
    expect(observeMutationToolCall("claude", call("Read"))).toMatchObject({
      coverage: "non_mutating",
      potentiallyMutating: false,
      descriptor: null,
    });
    expect(observeMutationToolCall("claude", call("mcp__change-intent__open_change_intent")))
      .toMatchObject({
      coverage: "non_mutating", potentiallyMutating: false, descriptor: null,
    });
  });
});

describe("emitMutationToolObservation", () => {
  it("emits additive observe-only telemetry without altering the call", () => {
    const emitToSession = vi.fn();
    const bus = { emitToSession } as unknown as Bus;
    const event = call("Edit", { file_path: "src/a.ts" });

    emitMutationToolObservation({
      bus,
      sessionKey: "run-1",
      harness: "claude",
      event,
      timestamp: 123,
    });

    expect(emitToSession).toHaveBeenCalledWith("run-1", {
      type: "mutation_tool_observed",
      sessionKey: "run-1",
      runKey: "run-1",
      workItemId: null,
      callId: "call-1",
      observeOnly: true,
      harness: "claude",
      toolName: "Edit",
      coverage: "extracted",
      potentiallyMutating: true,
      descriptor: { operation: "write", paths: ["src/a.ts"], opaque: false },
      timestamp: 123,
    });
    expect(event).toEqual(call("Edit", { file_path: "src/a.ts" }));
  });

  it("keeps known non-mutations in logs instead of duplicating their sdk event", () => {
    const emitToSession = vi.fn();
    emitMutationToolObservation({
      bus: { emitToSession } as unknown as Bus,
      sessionKey: "run-1",
      harness: "claude",
      event: call("Read", { file_path: "src/a.ts" }),
      timestamp: 123,
    });

    expect(emitToSession).not.toHaveBeenCalled();
  });

  it("is wired before the unchanged sdk event at the normalized host boundary", () => {
    const emitted: Array<Record<string, unknown>> = [];
    const bus = {
      emitToSession: (_sessionKey: string, payload: Record<string, unknown>) => emitted.push(payload),
    } as unknown as Bus;
    const buffered: Array<Record<string, unknown>> = [];
    const host = {
      id: "run-1",
      runKey: "immutable-run-1",
      workItemId: "work-1",
      role: "default",
      harnessName: "claude",
      bufferEvent: (event: Record<string, unknown>) => buffered.push(event),
      normalizedEventEnvelope: (event: NormalizedEvent, timestamp: number) => ({
        type: "sdk_event", sessionKey: "run-1", event, timestamp,
      }),
    } as unknown as SessionHost;
    const event = call("Write", { file_path: "src/a.ts" });

    processNormalizedEvent(
      host,
      bus,
      { id: "default", detectsSubagents: false } as unknown as AgentType,
      {} as AgentTypeContext,
      event,
    );

    expect(emitted.map((payload) => payload["type"])).toEqual([
      "mutation_tool_observed",
      "sdk_event",
    ]);
    expect(buffered).toHaveLength(1);
    expect(buffered[0]?.["event"]).toBe(event);
    expect(emitted[0]).toMatchObject({
      sessionKey: "run-1",
      runKey: "immutable-run-1",
      workItemId: "work-1",
    });
  });
});
