import { beforeEach, describe, expect, it, vi } from "vitest";
import { disablePersistence } from "../session-persist.ts";
import { createLeaderStateCallbacks } from "./leader-state-callbacks.ts";
import type { AgentTypeContext } from "./types.ts";

function context() {
  const markDecisionNeeded = vi.fn();
  const markDashboardChanged = vi.fn();
  const ctx = {
    markDecisionNeeded,
    markDashboardChanged,
  } as unknown as AgentTypeContext;
  return { ctx, markDecisionNeeded, markDashboardChanged };
}

beforeEach(() => disablePersistence());

describe("createLeaderStateCallbacks", () => {
  it("does not mark a decision for an answered form", () => {
    const { ctx, markDecisionNeeded, markDashboardChanged } = context();
    const callbacks = createLeaderStateCallbacks(ctx, "leader-1");

    callbacks.onRenderStateChange({
      layout: { columns: 2, gap: 12 },
      components: [{
        id: "answered",
        type: "form",
        fields: [],
        submittedAnswers: { choice: "A" },
      }],
    });

    expect(markDashboardChanged).toHaveBeenCalledOnce();
    expect(markDecisionNeeded).not.toHaveBeenCalled();
  });

  it("marks a decision for an unanswered form nested inside tabs and sections", () => {
    const { ctx, markDecisionNeeded } = context();
    const callbacks = createLeaderStateCallbacks(ctx, "leader-1");

    callbacks.onRenderStateChange({
      layout: { columns: 2, gap: 12 },
      components: [{
        id: "tabs",
        type: "tabs",
        tabs: [{
          id: "details",
          label: "Details",
          components: [{
            id: "section",
            type: "section",
            title: "Decision",
            components: [{ id: "pending", type: "form", fields: [] }],
          }],
        }],
      }],
    });

    expect(markDecisionNeeded)
      .toHaveBeenCalledWith("Dashboard input requested");
  });
});
