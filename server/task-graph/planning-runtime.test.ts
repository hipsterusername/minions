import "./test-helpers.ts";
import { describe, expect, it, vi } from "vitest";
import type { Bus } from "../bus.ts";
import { SessionHost } from "../session-host.ts";
import { initDb } from "../db.ts";
import type { TaskGraphPlanSnapshotView } from "../../shared/task-graph-planning-contracts.ts";
import type { SessionRegistry } from "../session-registry.ts";
import type { SessionHostDeps } from "../session-host-types.ts";
import { TaskGraphPlanningCoordinator } from "./planning-coordinator.ts";
import { installTaskGraphPlanningRuntime } from "./planning-runtime.ts";
import type { TaskGraphService } from "./service.ts";

describe("planning runtime installation", () => {
  it("defers planning recovery until the caller has hydrated the session registry", () => {
    const db = initDb(":memory:");
    const bus: Bus = {
      emit: () => {}, emitToSession: () => {}, emitToProject: () => {},
      emitGlobal: () => {}, subscribe: () => () => {},
    };
    const sessionDeps = {
      bus, startChildSession: () => {}, forEachLeaderTaskState: () => {},
    } as SessionHostDeps;
    const start = vi.spyOn(TaskGraphPlanningCoordinator.prototype, "start");

    const coordinator = installTaskGraphPlanningRuntime({
      db, bus,
      registry: { get: () => null } as unknown as SessionRegistry,
      sessionDeps,
      taskGraphs: { options: { db } } as unknown as TaskGraphService,
    });

    expect(start).not.toHaveBeenCalled();
    coordinator.start();
    expect(start).toHaveBeenCalledOnce();
    coordinator.dispose();
    start.mockRestore();
  });

  it("resumes the bound Leader once when terminal reconciliation arrives", async () => {
    const db = initDb(":memory:");
    const bus: Bus = {
      emit: () => {}, emitToSession: () => {}, emitToProject: () => {},
      emitGlobal: () => {}, subscribe: () => () => {},
    };
    const leader = new SessionHost("primary", "/tmp/work");
    leader.status = "idle";
    leader.role = "leader";
    leader.workItemId = "work";
    leader.runKind = "primary";
    leader.sessionId = "sdk-primary";
    const resumeWorkItemRun = vi.fn().mockResolvedValue(undefined);
    const sessionDeps = { bus, startChildSession: vi.fn(), resumeWorkItemRun,
      forEachLeaderTaskState: () => {} } as unknown as SessionHostDeps;
    const coordinator = installTaskGraphPlanningRuntime({ db, bus,
      registry: { get: (key:string) => key === "primary" ? leader : undefined } as unknown as SessionRegistry,
      sessionDeps, taskGraphs: { options: { db } } as unknown as TaskGraphService });
    const terminalPlan = { proposalId:"proposal",workItemId:"work",primaryRunKey:"primary",
      graphRunId:"graph",state:"completed" } as TaskGraphPlanSnapshotView;

    coordinator.options.onTerminal?.(terminalPlan);
    await vi.waitFor(() => expect(resumeWorkItemRun).toHaveBeenCalledOnce());
    expect(resumeWorkItemRun.mock.calls[0]?.[0]).toMatchObject({
      workItemId:"work",runKey:"primary",requestId:expect.stringMatching(/^wake:primary:/),
    });
    coordinator.dispose();
  });
});
