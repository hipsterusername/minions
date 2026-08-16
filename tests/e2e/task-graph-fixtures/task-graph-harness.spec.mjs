import fs from "node:fs";
import Database from "better-sqlite3";
import { expect, test } from "@playwright/test";
import {
  closeTaskGraphSocket,
  connectTaskGraphSocket,
  graphFixture,
  sendCommand,
} from "../task-graph-harness.mjs";

test("drives a real credential-free Task Graph through browser, dispatcher, SQLite, and child events", async ({ page }) => {
  const baseProjectPath = process.env.MINIONS_E2E_PROJECT;
  const dbPath = process.env.MINIONS_E2E_DB;
  if (!baseProjectPath || !dbPath) throw new Error("Task Graph E2E environment is missing");
  const projectPath = `${baseProjectPath}-task-graph`;

  await page.goto("/");
  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByPlaceholder("/path/to/new/project...").fill(projectPath);
  await page
    .getByPlaceholder("Project name (optional, defaults to folder name)")
    .fill("Task Graph Harness");
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
    title: "Task Graph deterministic E2E",
    changeMode: "live",
  });
  const detail = createWorkItem.result;
  const workItemId = detail.workItem.id;
  expect(createWorkItem.topic).toBe(`work-item:${workItemId}`);
  expect(detail.workItem.lifecycle.lifecycleRevision).toBe(0);

  const primary = await sendCommand(page, {
    type: "start_work_item_run",
    requestId: crypto.randomUUID(),
    workItemId,
    expectedLifecycleRevision: 0,
    expectedCurrentRunKey: null,
    prompt: "Hold the primary authority open for the deterministic Task Graph fixture.",
    harness: "pi",
    model: "fixture/model",
    permissionMode: "auto",
  });
  const primaryRunKey = primary.result.workItem.currentRunKey;
  expect(primaryRunKey).toMatch(/^run-/);
  const fixture = graphFixture({ workItemId, workspaceId, primaryRunKey });
  const createRevision = await sendCommand(page, {
    type: "create_task_graph_revision",
    requestId: crypto.randomUUID(),
    workItemId,
    graphRevision: fixture.revision,
  });
  expect(createRevision.result.revisionId).toBe(fixture.revisionId);

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

  let completed;
  await expect.poll(async () => {
    const envelope = await sendCommand(page, {
      type: "get_task_graph_snapshot",
      requestId: crypto.randomUUID(),
      workItemId,
      runId: fixture.graphRunId,
    });
    completed = envelope.snapshot;
    return completed.status;
  }, { timeout: 15_000 }).toBe("completed");

  const node = completed.nodes.find((candidate) => candidate.id === "proof-node");
  expect(node).toMatchObject({
    logicalState: "succeeded",
    readiness: "terminal",
    currentAttempt: { number: 1, state: "succeeded" },
  });
  expect(node.currentAttempt.sessionId).toMatch(/^run-/);
  expect(completed.timeline.some((event) => event.type === "dispatch")).toBe(true);
  expect(completed.timeline.some((event) => event.type === "progress")).toBe(true);

  expect(fs.existsSync(dbPath)).toBe(true);
  const db = new Database(dbPath, { readonly: true });
  try {
    expect(db.prepare("SELECT status FROM task_graph_runs WHERE id = ?")
      .get(fixture.graphRunId)).toEqual({ status: "completed" });
    expect(db.prepare(`SELECT runtime, outcome, session_run_key FROM task_node_attempts
      WHERE run_id = ? AND node_id = ?`).get(fixture.graphRunId, "proof-node"))
      .toMatchObject({ runtime: "terminal", outcome: "succeeded" });
    expect(db.prepare(`SELECT run_kind, attempt_id, attempt_number, run_outcome FROM sessions
      WHERE work_item_id = ? AND task_id = ?`).get(workItemId, "proof-node"))
      .toMatchObject({ run_kind: "child", attempt_number: 1, run_outcome: "completed" });
  } finally {
    db.close();
  }

  await sendCommand(page, {
    type: "review_work_item",
    requestId: crypto.randomUUID(),
    workItemId,
    expectedLifecycleRevision: 1,
    expectedCurrentRunKey: primaryRunKey,
  });
  await closeTaskGraphSocket(page);
});
