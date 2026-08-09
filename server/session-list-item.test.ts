import { describe, expect, it } from "vitest";
import { SessionHost } from "./session-host.ts";
import { buildSessionListItem } from "./session-list-item.ts";

describe("buildSessionListItem run identity", () => {
  it("exposes additive canonical primary/child metadata", () => {
    const host = new SessionHost("child-run", "/repo");
    host.workItemId = "work-1";
    host.seedRunLineage({
      runKind: "child", parentRunKey: "primary-run", taskId: "task-1",
    });

    expect(buildSessionListItem(host.id, host)).toMatchObject({
      sessionKey: "child-run", runKey: "child-run", workItemId: "work-1",
      runKind: "child", parentRunKey: "primary-run", taskId: "task-1",
    });
  });
});
