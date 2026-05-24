import { describe, expect, it, vi } from "vitest";
import type { WebSocketServer } from "ws";
import { createBus } from "../bus.ts";
import { getAgentType } from "./registry.ts";
import { LEADER_SYSTEM_PROMPT } from "./leader.ts";
import "./leader.ts";

describe("leader agent reasoning map wiring", () => {
  it("documents reasoning graph constraints in the prompt", () => {
    expect(LEADER_SYSTEM_PROMPT).toContain("create_reasoning_map");
    expect(LEADER_SYSTEM_PROMPT).toContain("Every hypothesis must include `falsifiedBy`");
    expect(LEADER_SYSTEM_PROMPT).toContain("Do not expose private chain-of-thought");
  });

  it("exposes reasoning map tools to leader sessions", () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const result = getAgentType("leader").getToolGroups({
      sessionKey: "leader-1",
      cwd: "/tmp/project",
      bus,
      worktreeInfo: null,
      worktreeIsolation: false,
      startMinionSession: vi.fn(),
      scheduleWaitContinue: vi.fn(),
    });

    expect(Object.keys(result.toolGroups)).toContain("reasoning-map");
    expect(result.mcpToolNames).toContain(
      "mcp__reasoning-map__create_reasoning_map",
    );
    expect(result.reasoningMapState).toEqual({ maps: [] });
  });

  it("publishes reasoning graph state into the dashboard side panel", async () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const envelopes: Array<Record<string, unknown>> = [];
    bus.subscribe((envelope) => envelopes.push(envelope));
    const result = getAgentType("leader").getToolGroups({
      sessionKey: "leader-1",
      cwd: "/tmp/project",
      bus,
      worktreeInfo: null,
      worktreeIsolation: false,
      startMinionSession: vi.fn(),
      scheduleWaitContinue: vi.fn(),
    });

    const createMap = result.toolGroups["reasoning-map"]!.find(
      (tool) => tool.name === "create_reasoning_map",
    )!;
    await createMap.handler({
      title: "Risky refactor",
      outcome: {
        title: "Refactor safely",
        summary: "Keep behavior while changing structure.",
        successSignal: "Focused tests pass.",
      },
    });

    expect(result.renderState?.components).toContainEqual(
      expect.objectContaining({
        id: "reasoning-map-dashboard",
        type: "section",
        title: "Reasoning Graph",
      }),
    );
    expect(envelopes).toContainEqual(
      expect.objectContaining({
        type: "render_update",
        leaderSessionKey: "leader-1",
        action: "append",
        components: [
          expect.objectContaining({
            id: "reasoning-map-dashboard",
            type: "section",
          }),
        ],
      }),
    );
  });
});
