import { randomUUID } from "node:crypto";

const HASH = `sha256:${"0".repeat(64)}`;

export async function connectTaskGraphSocket(page) {
  await page.evaluate(async () => {
    if (window.__minionsTaskGraphHarness?.socket?.readyState === WebSocket.OPEN) return;
    const tokenResponse = await fetch("/api/auth/token");
    if (!tokenResponse.ok) throw new Error(`Auth bootstrap failed: ${tokenResponse.status}`);
    const { token } = await tokenResponse.json();
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`,
    );
    const state = {
      socket,
      messages: [],
      waiters: [],
      request(commands, matcher, timeoutMs = 10_000) {
        return new Promise((resolve, reject) => {
          const waiter = { matcher, resolve, reject, timer: 0 };
          waiter.timer = window.setTimeout(() => {
            state.waiters = state.waiters.filter((candidate) => candidate !== waiter);
            reject(new Error(`Timed out waiting for ${JSON.stringify(matcher)}`));
          }, timeoutMs);
          state.waiters.push(waiter);
          for (const command of commands) socket.send(JSON.stringify(command));
        });
      },
    };
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      state.messages.push(message);
      for (const waiter of [...state.waiters]) {
        const matches = Object.entries(waiter.matcher).every(
          ([key, value]) => message[key] === value,
        );
        if (!matches) continue;
        window.clearTimeout(waiter.timer);
        state.waiters = state.waiters.filter((candidate) => candidate !== waiter);
        waiter.resolve(message);
      }
    });
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket failed to open")), {
        once: true,
      });
    });
    window.__minionsTaskGraphHarness = state;
  });
}

export async function sendCommand(page, command) {
  const matcher = command.type === "get_task_graph_snapshot"
    ? { type: "task_graph_snapshot", runId: command.runId, cause: "command_snapshot" }
    : command.type.includes("task_graph")
      ? { type: "task_graph_response", requestId: command.requestId }
      : { type: "work_item_response", requestId: command.requestId };
  const response = await page.evaluate(
    ({ command, matcher }) => window.__minionsTaskGraphHarness.request([command], matcher),
    { command, matcher },
  );
  assertSuccessfulResponse(response);
  return response;
}

export function graphFixture({ workItemId, workspaceId, primaryRunKey }) {
  const definitionId = `e2e-definition-${randomUUID()}`;
  const revisionId = `e2e-revision-${randomUUID()}`;
  const graphRunId = `e2e-graph-${randomUUID()}`;
  const now = Date.now();
  return {
    graphRunId,
    revisionId,
    revision: {
      definitionId,
      revisionId,
      workItemId,
      workspaceId,
      objective: "Prove the deterministic browser-to-child Task Graph path",
      acceptanceCriteria: ["The echo-backed child attempt succeeds"],
      nonGoals: [],
      constraints: ["No external credentials or network calls"],
      terminalNodeIds: ["proof-node"],
      maxActiveAttempts: 1,
      edges: [],
      nodes: [{
        id: "proof-node",
        title: "Credential-free proof child",
        objective: "Complete through the real child-run lifecycle",
        inputBindings: {},
        outputSchemas: {},
        constraints: [],
        acceptanceCriteria: ["Return a terminal report"],
        executorClass: "mechanical",
        allowedHarnesses: ["echo"],
        allowedTools: [],
        ownershipRequest: [],
        budgetRequest: {},
        timeoutMs: 30_000,
        retryPolicy: {
          maxAttempts: 1,
          backoffMs: 0,
          retryableOutcomes: [],
          jitterMs: 0,
        },
        verificationRequired: false,
        failurePolicy: "fail_graph",
        expansionPolicy: null,
      }],
    },
    sourceSnapshot: {
      id: `e2e-source-${randomUUID()}`,
      workItemId,
      primaryRunKey,
      taskGraphRevisionId: revisionId,
      repositoryBaseCommit: "e2e-fixture",
      dirtyDiffDigest: HASH,
      workspaceId,
      worktreeIdentity: "e2e-live-worktree",
      systemModelDigest: HASH,
      workPacketRevisionId: null,
      connectedContext: [],
      compiledSkills: [],
      harnessPolicyDigest: HASH,
      toolPolicyDigest: HASH,
      createdAt: now,
    },
  };
}

export async function closeTaskGraphSocket(page) {
  await page.evaluate(() => {
    window.__minionsTaskGraphHarness?.socket?.close();
    delete window.__minionsTaskGraphHarness;
  });
}

function assertSuccessfulResponse(response) {
  if (response?.success === false) {
    throw new Error(`${response.command} failed (${response.code}): ${response.error}`);
  }
}
