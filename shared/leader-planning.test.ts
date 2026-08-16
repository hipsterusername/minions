import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEADER_PLANNING_BACKEND,
  defaultOrchestrationModeForBackend,
  normalizeLeaderPlanningBackend,
  planningBackendForOrchestrationMode,
} from "./leader-planning.ts";

describe("leader planning backend", () => {
  it("normalizes absent and unknown settings to the Task Graph standard", () => {
    expect(DEFAULT_LEADER_PLANNING_BACKEND).toBe("task_graph");
    expect(normalizeLeaderPlanningBackend(undefined)).toBe("task_graph");
    expect(normalizeLeaderPlanningBackend("future-backend")).toBe("task_graph");
  });

  it("maps only the legacy backend to direct orchestration", () => {
    expect(defaultOrchestrationModeForBackend("task_graph")).toBe("auto");
    expect(defaultOrchestrationModeForBackend("legacy")).toBe("direct");
    expect(planningBackendForOrchestrationMode("auto")).toBe("task_graph");
    expect(planningBackendForOrchestrationMode("plan")).toBe("task_graph");
    expect(planningBackendForOrchestrationMode("direct")).toBe("legacy");
  });
});
