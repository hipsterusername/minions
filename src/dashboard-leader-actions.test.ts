import { describe, expect, it } from "vitest";

import {
  DEFAULT_DASHBOARD_LEADER_ACTION_NAMES,
  DEFAULT_DASHBOARD_LEADER_ACTION_PROMPTS,
  resolveDashboardLeaderActionName,
  resolveDashboardLeaderPrompt,
} from "./dashboard-leader-actions.ts";

describe("resolveDashboardLeaderActionName", () => {
  it("uses the configured dashboard action name when present", () => {
    expect(
      resolveDashboardLeaderActionName(
        {
          dashboardLeaderActionNames: {
            improve: "Polish",
          },
        },
        "improve",
      ),
    ).toBe("Polish");
  });

  it("falls back to the default name for blank or missing settings", () => {
    expect(
      resolveDashboardLeaderActionName(
        { dashboardLeaderActionNames: { execute: "   " } },
        "execute",
      ),
    ).toBe(DEFAULT_DASHBOARD_LEADER_ACTION_NAMES.execute);

    expect(resolveDashboardLeaderActionName(undefined, "analyze")).toBe(
      DEFAULT_DASHBOARD_LEADER_ACTION_NAMES.analyze,
    );
  });
});

describe("resolveDashboardLeaderPrompt", () => {
  it("uses the configured dashboard action prompt when present", () => {
    expect(
      resolveDashboardLeaderPrompt(
        {
          dashboardLeaderActionPrompts: {
            improve: "Make this sharper.",
          },
        },
        "improve",
      ),
    ).toBe("Make this sharper.");
  });

  it("falls back to the default prompt for blank or missing settings", () => {
    expect(
      resolveDashboardLeaderPrompt(
        { dashboardLeaderActionPrompts: { execute: "   " } },
        "execute",
      ),
    ).toBe(DEFAULT_DASHBOARD_LEADER_ACTION_PROMPTS.execute);

    expect(resolveDashboardLeaderPrompt(undefined, "analyze")).toBe(
      DEFAULT_DASHBOARD_LEADER_ACTION_PROMPTS.analyze,
    );
  });
});
