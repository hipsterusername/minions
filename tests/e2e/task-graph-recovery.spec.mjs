import fs from "node:fs";
import Database from "better-sqlite3";
import { expect, test } from "@playwright/test";
import {
  closeTaskGraphSocket,
  connectTaskGraphSocket,
  graphFixture,
  sendCommand,
} from "./task-graph-harness.mjs";

function canonicalRows(dbPath, graphRunId) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      run: db.prepare(`SELECT status, paused, revision, updated_at
        FROM task_graph_runs WHERE id = ?`).get(graphRunId),
      attempts: db.prepare(`SELECT id, generation, runtime, outcome, session_run_key, updated_at
        FROM task_node_attempts WHERE run_id = ? ORDER BY node_id, attempt_number`)
        .all(graphRunId),
      events: db.prepare("SELECT count(*) AS count FROM task_scheduler_events WHERE run_id = ?")
        .get(graphRunId),
    };
  } finally {
    db.close();
  }
}

async function sendConflictingCommand(page, command) {
  return page.evaluate((candidate) => window.__minionsTaskGraphHarness.request(
    [candidate],
    { type: "task_graph_response", requestId: candidate.requestId },
  ), command);
}

test("reconnect refetch converges in flight and a stale control cannot rewrite SQLite", async ({ page }) => {
  const baseProjectPath = process.env.MINIONS_E2E_PROJECT;
  const dbPath = process.env.MINIONS_E2E_DB;
  if (!baseProjectPath || !dbPath) throw new Error("Task Graph E2E environment is missing");
  const projectPath = `${baseProjectPath}-task-graph-recovery`;

  await page.goto("/");
  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByPlaceholder("/path/to/new/project...").fill(projectPath);
  await page
    .getByPlaceholder("Project name (optional, defaults to folder name)")
    .fill("Task Graph Recovery");
  const createdResponse = page.waitForResponse((response) =>
    response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/projects"
      && response.status() === 201);
  await page.getByRole("button", { name: "Create" }).click();
  const project = await (await createdResponse).json();
  const workspaceId = project.workspaceId ?? project.id;

  await connectTaskGraphSocket(page);
  const createWorkItem = await sendCommand(page, {
    type: "create_work_item",
    requestId: crypto.randomUUID(),
    workspaceId,
    title: "Task Graph reconnect recovery E2E",
    changeMode: "live",
  });
  const workItemId = createWorkItem.result.workItem.id;
  const primary = await sendCommand(page, {
    type: "start_work_item_run",
    requestId: crypto.randomUUID(),
    workItemId,
    expectedLifecycleRevision: 0,
    expectedCurrentRunKey: null,
    prompt: "Hold canonical authority open while the recovery fixture runs.",
    harness: "pi",
    model: "fixture/model",
    permissionMode: "auto",
  });
  const primaryRunKey = primary.result.workItem.currentRunKey;
  const fixture = graphFixture({ workItemId, workspaceId, primaryRunKey });
  fixture.revision.nodes[0].objective =
    "Remain live across reconnect until cancelled [[echo:hold]]";
  fixture.revision.nodes[0].timeoutMs = 45_000;

  try {
    await sendCommand(page, {
      type: "create_task_graph_revision",
      requestId: crypto.randomUUID(),
      workItemId,
      graphRevision: fixture.revision,
    });
    await sendCommand(page, {
      type: "start_task_graph_run",
      requestId: crypto.randomUUID(),
      runId: fixture.graphRunId,
      workItemId,
      primaryRunKey,
      revisionId: fixture.revisionId,
      sourceSnapshot: fixture.sourceSnapshot,
      expectedLifecycleRevision: 1,
    });

    let beforeReload;
    let beforeReloadEnvelope;
    await expect.poll(async () => {
      const envelope = await sendCommand(page, {
        type: "get_task_graph_snapshot",
        requestId: crypto.randomUUID(),
        workItemId,
        runId: fixture.graphRunId,
      });
      beforeReloadEnvelope = envelope;
      beforeReload = envelope.snapshot;
      return beforeReload.nodes[0]?.currentAttempt?.state;
    }, { timeout: 15_000 }).toBe("running");

    expect(beforeReload).toMatchObject({
      graphRunId: fixture.graphRunId,
      status: "running",
      nodes: [{
        id: "proof-node",
        logicalState: "pending",
        currentAttempt: { number: 1, state: "running" },
      }],
    });
    expect(beforeReloadEnvelope).toMatchObject({
      topic: `work-item:${workItemId}`,
      workItemId,
      runId: fixture.graphRunId,
      revision: beforeReload.revision,
      cause: "command_snapshot",
    });
    const attemptId = beforeReload.nodes[0].currentAttempt.id;
    const stableRows = canonicalRows(dbPath, fixture.graphRunId);
    expect(stableRows.run).toMatchObject({ status: "active", paused: 0 });
    expect(stableRows.attempts).toHaveLength(1);
    expect(stableRows.attempts[0]).toMatchObject({
      id: attemptId,
      generation: 1,
      runtime: "running",
      outcome: "none",
    });

    await page.reload();
    await connectTaskGraphSocket(page);
    const refetchedEnvelope = await sendCommand(page, {
      type: "get_task_graph_snapshot",
      requestId: crypto.randomUUID(),
      workItemId,
      runId: fixture.graphRunId,
    });
    const refetched = refetchedEnvelope.snapshot;

    expect(refetched).toMatchObject({
      graphRunId: fixture.graphRunId,
      revision: beforeReload.revision,
      status: "running",
    });
    expect(refetchedEnvelope).toMatchObject({
      topic: `work-item:${workItemId}`,
      workItemId,
      runId: fixture.graphRunId,
      revision: beforeReload.revision,
      cause: "command_snapshot",
    });
    expect(refetched.nodes[0].currentAttempt).toMatchObject({
      id: attemptId,
      number: 1,
      state: "running",
    });

    const staleRevision = refetched.revision - 1;
    expect(staleRevision).toBeGreaterThanOrEqual(0);
    const conflict = await sendConflictingCommand(page, {
      type: "pause_task_graph_run",
      requestId: crypto.randomUUID(),
      workItemId,
      runId: fixture.graphRunId,
      expectedRunRevision: staleRevision,
    });
    expect(conflict).toMatchObject({
      command: "pause_task_graph_run",
      success: false,
      code: "conflict",
      latest: {
        runId: fixture.graphRunId,
        revision: refetched.revision,
        status: "active",
      },
    });

    const afterConflict = (await sendCommand(page, {
      type: "get_task_graph_snapshot",
      requestId: crypto.randomUUID(),
      workItemId,
      runId: fixture.graphRunId,
    })).snapshot;
    expect(afterConflict).toMatchObject({
      revision: refetched.revision,
      status: "running",
      nodes: [{ currentAttempt: { id: attemptId, number: 1, state: "running" } }],
    });
    expect(canonicalRows(dbPath, fixture.graphRunId)).toEqual(stableRows);

    await sendCommand(page, {
      type: "cancel_task_graph_run",
      requestId: crypto.randomUUID(),
      workItemId,
      runId: fixture.graphRunId,
      expectedRunRevision: afterConflict.revision,
    });
  } finally {
    if (fs.existsSync(dbPath)) {
      await connectTaskGraphSocket(page).catch(() => undefined);
      const graph = await sendCommand(page, {
        type: "get_task_graph_snapshot",
        requestId: crypto.randomUUID(),
        workItemId,
        runId: fixture.graphRunId,
      }).catch(() => null);
      if (["running", "quiescent", "paused", "blocked"].includes(graph?.snapshot?.status)) {
        await sendCommand(page, {
          type: "cancel_task_graph_run",
          requestId: crypto.randomUUID(),
          workItemId,
          runId: fixture.graphRunId,
          expectedRunRevision: graph.snapshot.revision,
        }).catch(() => null);
      }
      const detail = await sendCommand(page, {
        type: "get_work_item",
        requestId: crypto.randomUUID(),
        workItemId,
      }).catch(() => null);
      const workItem = detail?.result?.workItem;
      if (workItem?.currentRunKey) {
        await sendCommand(page, {
          type: "review_work_item",
          requestId: crypto.randomUUID(),
          workItemId,
          expectedLifecycleRevision: workItem.lifecycle.lifecycleRevision,
          expectedCurrentRunKey: workItem.currentRunKey,
        }).catch(() => null);
      }
    }
    await closeTaskGraphSocket(page).catch(() => undefined);
  }
});
