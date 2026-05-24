import { describe, expect, it } from "vitest";
import { renderComponentSchema } from "../shared/render-dsl.ts";
import {
  applyReasoningOps,
  createReasoningMap,
  validateReasoningMap,
} from "../shared/reasoning-map.ts";
import { buildReasoningMapDashboard } from "./reasoning-map-dashboard.ts";

const now = "2026-05-23T12:00:00.000Z";

describe("reasoning-map-dashboard", () => {
  it("builds valid Render DSL components for an empty map", () => {
    const map = createReasoningMap({
      id: "map",
      title: "Plan risky refactor",
      now,
      outcome: {
        title: "Refactor safely",
        summary: "Complete the refactor with tests.",
        successSignal: "Targeted tests pass.",
        basis: "user_confirmed",
        confidence: "medium",
      },
    });

    const components = buildReasoningMapDashboard(map, validateReasoningMap(map, now));

    expect(components.map((component) => component.id)).toContain("reasoning-map-tabs");
    for (const component of components) {
      expect(() => renderComponentSchema.parse(component)).not.toThrow();
    }
  });

  it("includes active path, validation findings, and challenges", () => {
    let map = createReasoningMap({
      id: "map",
      title: "Debug checkout",
      now,
      outcome: {
        title: "Checkout works",
        summary: "Find and fix the failure.",
        successSignal: "Checkout test passes.",
        basis: "user_confirmed",
        confidence: "medium",
      },
    });
    map = applyReasoningOps(map, [
      {
        op: "add_node",
        node: {
          id: "decision",
          type: "decision",
          title: "Patch cache",
          summary: "Change cache invalidation.",
          state: "active",
          basis: "assumed",
          confidence: "high",
          rationale: "Cache is a plausible cause.",
          reversible: true,
          risk: {
            severity: "critical",
            summary: "Could hide a data bug.",
            resolved: false,
          },
        },
      },
    ], { now }).map;
    map = {
      ...map,
      challenges: [
        {
          id: "challenge-1",
          nodeId: "decision",
          userText: "This assumption is too weak.",
          status: "open",
          createdAt: now,
        },
      ],
    };

    const components = buildReasoningMapDashboard(map, validateReasoningMap(map, now));
    const text = JSON.stringify(components);

    expect(text).toContain("Patch cache");
    expect(text).toContain("decision_only_assumptions");
    expect(text).toContain("This assumption is too weak.");
  });
});
