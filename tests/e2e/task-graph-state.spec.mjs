import fs from "node:fs";
import Database from "better-sqlite3";
import { expect, test } from "@playwright/test";
import {
  closeTaskGraphSocket,
  connectTaskGraphSocket,
  graphFixture,
  sendCommand,
} from "./task-graph-harness.mjs";

test.use({ viewport: { width: 1440, height: 900 } });

test("converges successful and failure/retry/blocked Task Graph state through the real system", async ({ page }) => {
  const baseProjectPath = process.env.MINIONS_E2E_PROJECT;
  const dbPath = process.env.MINIONS_E2E_DB;
  if (!baseProjectPath || !dbPath) throw new Error("Task Graph E2E environment is missing");
  const projectPath = `${baseProjectPath}-task-graph-state`;

  await page.route(/https:\/\/fonts\.(?:googleapis|gstatic)\.com\/.*/, (route) =>
    route.abort(),
  );
  const project = await createProject(page, projectPath);
  const workspaceId = project.workspaceId ?? project.id;
  await connectTaskGraphSocket(page);

  // Launch from Canvas so the canonical WorkItem is bound to this real Leader
  // node and its LeaderTaskGraphBridge. Pi is a credential-free fixture here;
  // unlike Echo, it deliberately keeps the primary authority live.
  await page.getByRole("tab", { name: "Canvas" }).click();
  await page.getByTitle("Add Leader node").click();
  await page.getByRole("button", { name: "Model selection" }).click();
  await page.getByRole("tab", { name: "PI Pi", exact: true }).click();
  await page.getByRole("button", { name: "Deterministic Fixture Model" }).click();
  await page.getByRole("textbox", { name: "Leader prompt" }).fill(
    "Hold the canonical primary authority open for Task Graph state E2E.",
  );
  await page.getByRole("button", { name: "Start", exact: true }).click();

  const detail = await pollWorkItem(page, project.id);
  const workItemId = detail.id;
  const primaryRunKey = detail.currentRunKey;
  expect(primaryRunKey).toMatch(/^run-/);
  expect(detail.lifecycle.runtimeState).toBe("working");

  const graph = graphFixture({ workItemId, workspaceId, primaryRunKey });
  graph.revision.objective = "E2E Task Graph state journeys";
  graph.revision.acceptanceCriteria = [
    "One child succeeds and one missing-output child blocks until operator retry",
  ];
  graph.revision.terminalNodeIds = ["proof-node", "blocked-node"];
  graph.revision.nodes[0].title = "Successful credential-free child";
  graph.revision.nodes.push({
    ...graph.revision.nodes[0],
    id: "blocked-node",
    title: "Failed child requiring retry",
    objective: "Complete without staging the deliberately required output",
    outputSchemas: { requiredReport: { type: "object" } },
    retryPolicy: {
      maxAttempts: 1,
      backoffMs: 0,
      retryableOutcomes: ["failed"],
      jitterMs: 0,
    },
    failurePolicy: "block_for_decision",
  });
  await createAndStartGraph(page, graph, detail.lifecycle.lifecycleRevision);

  const firstBlocked = await pollGraph(page, workItemId, graph.graphRunId, "blocked");
  const succeededNode = firstBlocked.nodes.find((node) => node.id === "proof-node");
  const failedNode = firstBlocked.nodes.find((node) => node.id === "blocked-node");
  expect(succeededNode).toMatchObject({
    logicalState: "succeeded",
    readiness: "terminal",
    currentAttempt: { number: 1, state: "succeeded" },
  });
  expect(failedNode).toMatchObject({
    logicalState: "exhausted",
    readiness: "terminal",
    blocker: { category: "policy", explanation: "attempts exhausted" },
    currentAttempt: { number: 1, state: "failed" },
  });
  expect(firstBlocked.timeline.some((event) => event.type === "dispatch")).toBe(true);
  expect(firstBlocked.timeline.some((event) => event.type === "progress")).toBe(true);
  await expect(page.getByRole("region", {
    name: "Task graph E2E Task Graph state journeys",
  })).toContainText("blocked");

  await page.getByRole("region", {
    name: "Task graph E2E Task Graph state journeys",
  }).getByRole("button", { name: "Open graph" }).click();
  const inspector = page.getByRole("dialog", { name: "E2E Task Graph state journeys" });
  await inspector.getByRole("button", { name: /Failed child requiring retry/ }).click();
  const retry = inspector.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeEnabled();
  await retry.click();

  const secondBlocked = await pollGraphAttempt(
    page, workItemId, graph.graphRunId, "blocked-node", 2, "blocked",
  );
  expect(secondBlocked.revision).toBeGreaterThan(firstBlocked.revision);
  const retriedNode = secondBlocked.nodes.find((node) => node.id === "blocked-node");
  expect(retriedNode).toMatchObject({
    logicalState: "exhausted",
    currentAttempt: { number: 2, state: "failed" },
  });
  expect(retriedNode.attemptHistory.map((attempt) => attempt.number)).toEqual([1, 2]);
  await expect(inspector.getByRole("region", {
    name: "Execution goal and run status",
  })).toContainText("blocked");
  await expect(inspector.getByText("Attempt 2", { exact: true })).toBeVisible();
  await expectMonotonicProjection(page, graph.graphRunId, "blocked");

  assertSqliteEvidence(dbPath, graph.graphRunId, workItemId);

  await inspector.getByRole("button", { name: "Close graph inspector" }).click();
  await page.evaluate((sessionKey) => {
    window.__minionsTaskGraphHarness.socket.send(JSON.stringify({
      type: "stop_session",
      sessionKey,
    }));
  }, primaryRunKey);
  let latest;
  await expect.poll(async () => {
    latest = await sendCommand(page, {
      type: "get_work_item",
      requestId: crypto.randomUUID(),
      workItemId,
    });
    return latest.result.workItem.lifecycle.runtimeState;
  }, { timeout: 15_000 }).toBe("inactive");
  await sendCommand(page, {
    type: "review_work_item",
    requestId: crypto.randomUUID(),
    workItemId,
    expectedLifecycleRevision: latest.result.workItem.lifecycle.lifecycleRevision,
    expectedCurrentRunKey: primaryRunKey,
  });
  await closeTaskGraphSocket(page);
});

async function createProject(page, projectPath) {
  await page.goto("/");
  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByPlaceholder("/path/to/new/project...").fill(projectPath);
  await page.getByPlaceholder("Project name (optional, defaults to folder name)")
    .fill("Task Graph State");
  const createdResponse = page.waitForResponse((response) =>
    response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/projects"
      && response.status() === 201);
  await page.getByRole("button", { name: "Create" }).click();
  return (await createdResponse).json();
}

async function pollWorkItem(page, projectId) {
  let item;
  await expect.poll(async () => {
    const response = await sendCommand(page, {
      type: "list_work_items",
      requestId: crypto.randomUUID(),
      projectId,
      limit: 20,
    });
    item = response.result.items.find((candidate) =>
      candidate.title === "Hold the canonical primary authority open for Task Graph state E2E.");
    return item?.lifecycle.runtimeState;
  }, { timeout: 15_000 }).toBe("working");
  return item;
}

async function createAndStartGraph(page, fixture, expectedLifecycleRevision) {
  const created = await sendCommand(page, {
    type: "create_task_graph_revision",
    requestId: crypto.randomUUID(),
    workItemId: fixture.revision.workItemId,
    graphRevision: fixture.revision,
  });
  expect(created.result.revisionId).toBe(fixture.revisionId);
  return sendCommand(page, {
    type: "start_task_graph_run",
    requestId: crypto.randomUUID(),
    runId: fixture.graphRunId,
    workItemId: fixture.revision.workItemId,
    primaryRunKey: fixture.sourceSnapshot.primaryRunKey,
    revisionId: fixture.revisionId,
    sourceSnapshot: fixture.sourceSnapshot,
    expectedLifecycleRevision,
  });
}

async function pollGraph(page, workItemId, runId, status) {
  let snapshot;
  await expect.poll(async () => {
    snapshot = (await sendCommand(page, {
      type: "get_task_graph_snapshot",
      requestId: crypto.randomUUID(),
      workItemId,
      runId,
    })).snapshot;
    return snapshot.status;
  }, { timeout: 15_000 }).toBe(status);
  return snapshot;
}

async function pollGraphAttempt(page, workItemId, runId, nodeId, attemptNumber, status) {
  let snapshot;
  await expect.poll(async () => {
    snapshot = (await sendCommand(page, {
      type: "get_task_graph_snapshot",
      requestId: crypto.randomUUID(),
      workItemId,
      runId,
    })).snapshot;
    const currentAttempt = snapshot.nodes.find((node) => node.id === nodeId)?.currentAttempt;
    return `${currentAttempt?.number ?? "none"}:${snapshot.status}`;
  }, { timeout: 15_000 }).toBe(`${attemptNumber}:${status}`);
  return snapshot;
}

async function expectMonotonicProjection(page, runId, terminalStatus) {
  const envelopes = await page.evaluate((id) =>
    window.__minionsTaskGraphHarness.messages
      .filter((message) => message.runId === id
        && (message.type === "task_graph_snapshot" || message.type === "task_graph_changed"))
      .map((message) => ({
        type: message.type,
        revision: message.revision,
        status: message.snapshot?.status ?? message.changes?.status,
      })), runId);
  expect(envelopes.some((envelope) => envelope.type === "task_graph_snapshot")).toBe(true);
  expect(envelopes.some((envelope) => envelope.type === "task_graph_changed")).toBe(true);
  expect(envelopes.at(-1).status).toBe(terminalStatus);
  const revisions = envelopes.map((envelope) => envelope.revision);
  for (let index = 1; index < revisions.length; index += 1) {
    expect(revisions[index]).toBeGreaterThanOrEqual(revisions[index - 1]);
  }
  expect(new Set(revisions).size).toBeGreaterThan(1);
}

function assertSqliteEvidence(dbPath, runId, workItemId) {
  expect(fs.existsSync(dbPath)).toBe(true);
  const db = new Database(dbPath, { readonly: true });
  try {
    expect(db.prepare("SELECT status FROM task_graph_runs WHERE id = ?")
      .get(runId)).toEqual({ status: "blocked" });

    expect(db.prepare(`SELECT node_id, runtime, outcome, attempt_number FROM task_node_attempts
      WHERE run_id = ? ORDER BY node_id, attempt_number`).all(runId))
      .toEqual([
        { node_id: "blocked-node", runtime: "terminal", outcome: "failed", attempt_number: 1 },
        { node_id: "blocked-node", runtime: "terminal", outcome: "failed", attempt_number: 2 },
        { node_id: "proof-node", runtime: "terminal", outcome: "succeeded", attempt_number: 1 },
      ]);

    expect(db.prepare(`SELECT s.run_kind, s.work_item_id, s.attempt_number, s.run_outcome
      FROM sessions s JOIN task_node_attempts a ON a.session_run_key = s.session_key
      WHERE a.run_id = ? AND a.node_id = 'blocked-node' ORDER BY a.attempt_number`).all(runId))
      .toEqual([
        { run_kind: "child", work_item_id: workItemId, attempt_number: 1, run_outcome: "completed" },
        { run_kind: "child", work_item_id: workItemId, attempt_number: 2, run_outcome: "completed" },
      ]);
    expect(db.prepare(`SELECT kind, count(*) count,
      sum(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) delivered
      FROM task_scheduler_outbox WHERE run_id = ? GROUP BY kind`)
      .all(runId))
      .toEqual([{ kind: "dispatch", count: 3, delivered: 3 }]);
  } finally {
    db.close();
  }
}
