/**
 * Test script: Connect to the Canvas WS server, create a leader session,
 * and verify that assign_task MCP tool fires and minion_spawned events arrive.
 *
 * Usage:
 *   1. Start the server:  pnpm server
 *   2. Run this test:     node test-minion-spawn.mjs
 *
 * Expected output:
 *   - Leader session creates successfully
 *   - Leader calls assign_task MCP tool (visible as tool_use blocks)
 *   - Server broadcasts minion_spawned event
 *   - Minion session starts and streams events
 */
import { WebSocket } from "ws";

const WS_URL = "ws://localhost:3141";
const ws = new WebSocket(WS_URL);

const sessionKey = `leader-test-${Date.now().toString(36)}`;

// Tracking
let toolCalls = [];
let minionSpawns = [];
let assistantEvents = 0;
let streamEvents = 0;
let resultReceived = false;
let initTools = [];

ws.on("open", () => {
  console.log("Connected to", WS_URL);
  console.log("Creating leader session:", sessionKey);
  console.log();

  // Pass the leader system prompt so the model knows to use assign_task.
  // The server injects MCP tools (assign_task, get_task_status) for leader sessions.
  ws.send(
    JSON.stringify({
      type: "create_session",
      sessionKey,
      prompt:
        "Create a simple hello world Python file. This is a one-task job — assign it immediately.",
      systemPrompt: `You are the Leader agent in a multi-agent canvas system. You orchestrate work by decomposing tasks into discrete units and assigning them to Minion agents.

CRITICAL RULE: You are an ORCHESTRATOR ONLY. You MUST NEVER write code, edit files, run commands, or do implementation work yourself. Your ONLY job is to decompose goals into tasks and delegate them using the assign_task tool. When given any request, immediately use assign_task to delegate.

You have two task-management tools:
- assign_task: Creates a new Minion agent to execute a task. Parameters: taskId, title, description, priority.
- get_task_status: Check status of assigned tasks.

Always delegate. Never do work directly.`,
      role: "leader",
    })
  );
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());

  // ── minion_spawned events (from ANY session) ──
  if (msg.type === "minion_spawned") {
    minionSpawns.push(msg);
    console.log(`\n  MINION SPAWNED!`);
    console.log(`    minionSessionKey: ${msg.minionSessionKey}`);
    console.log(`    taskId: ${msg.taskId}`);
    console.log(`    title: ${msg.title}`);
    console.log(`    priority: ${msg.priority}`);
    return;
  }

  // ── agent_spawned events (SDK Agent tool subagents) ──
  if (msg.type === "agent_spawned") {
    console.log(`\n  AGENT SPAWNED (SDK Agent tool)!`);
    console.log(`    taskId: ${msg.taskId}`);
    console.log(`    title: ${msg.title}`);
    return;
  }

  // Only process events for our session below
  if (msg.sessionKey !== sessionKey) return;

  if (msg.type === "sdk_event") {
    const sdk = msg.message;
    const sdkType = sdk?.type;
    const sdkSubtype = sdk?.subtype;

    if (sdkType === "system") {
      if (sdkSubtype === "init") {
        initTools = sdk.tools ?? [];
        const mcpServers = sdk.mcp_servers ?? [];
        console.log(`  INIT — model: ${sdk.model}`);
        console.log(`    Built-in tools: ${initTools.join(", ")}`);
        console.log(`    MCP servers: ${mcpServers.map((s) => `${s.name}(${s.status})`).join(", ") || "none"}`);
      } else {
        // Skip noisy system events
      }
    } else if (sdkType === "stream_event") {
      streamEvents++;
      const evtType = sdk?.event?.type;
      if (evtType === "content_block_delta") {
        const delta = sdk?.event?.delta;
        if (delta?.type === "text_delta") {
          process.stdout.write(delta.text ?? "");
        }
      }
    } else if (sdkType === "assistant") {
      assistantEvents++;
      const content = sdk?.message?.content ?? [];

      // Check for tool_use blocks (assign_task calls)
      const toolUses = content.filter((b) => b.type === "tool_use");
      for (const tu of toolUses) {
        toolCalls.push(tu);
        console.log(`\n  TOOL CALL: ${tu.name}`);
        console.log(`    Input: ${JSON.stringify(tu.input, null, 2)}`);
      }

      // Check for text blocks
      const textBlocks = content.filter((b) => b.type === "text");
      if (textBlocks.length > 0 && toolUses.length === 0) {
        const preview = textBlocks.map((b) => b.text).join("").slice(0, 200);
        console.log(`\n  ASSISTANT (text only): ${preview}...`);
      }
    } else if (sdkType === "tool_progress") {
      // Tool execution in progress
      process.stdout.write(`.`);
    } else if (sdkType === "result") {
      resultReceived = true;
      console.log(
        `\n  RESULT — cost: $${sdk.total_cost_usd?.toFixed(4) ?? "?"}, turns: ${sdk.num_turns ?? "?"}`
      );
    }
  } else if (msg.type === "session_status") {
    console.log(`  Status: ${msg.status}`);
    if (msg.status === "idle") {
      printSummary();
    }
  } else if (msg.type === "session_error") {
    console.log(`  ERROR: ${msg.error}`);
    printSummary();
  }
});

function printSummary() {
  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));
  console.log(`  Stream events:    ${streamEvents}`);
  console.log(`  Assistant events: ${assistantEvents}`);
  console.log(`  Tool calls:       ${toolCalls.length}`);
  for (const tc of toolCalls) {
    console.log(`    - ${tc.name}(${JSON.stringify(tc.input).slice(0, 100)})`);
  }
  console.log(`  Minion spawns:    ${minionSpawns.length}`);
  for (const ms of minionSpawns) {
    console.log(`    - ${ms.taskId}: "${ms.title}" -> ${ms.minionSessionKey}`);
  }
  console.log(`  Result received:  ${resultReceived}`);
  console.log();

  // Diagnosis
  if (toolCalls.length === 0) {
    console.log(
      "  DIAGNOSIS: Leader never called assign_task!"
    );
    if (!initTools.includes("assign_task") && !initTools.some((t) => t.includes("task"))) {
      console.log(
        "    -> MCP tools may not be registered. Check that createSdkMcpServer"
      );
      console.log(
        "       returns tools visible to the model (check init event's mcp_servers)."
      );
    } else {
      console.log(
        "    -> Tools ARE available but model chose not to use them."
      );
      console.log(
        "       Check system prompt or try a more directive user prompt."
      );
    }
  } else if (minionSpawns.length === 0) {
    console.log(
      "  DIAGNOSIS: Leader called assign_task but no minion_spawned event received!"
    );
    console.log(
      "    -> Check server broadcast() and startMinionSession() for errors."
    );
  } else {
    console.log(
      "  SUCCESS: Leader assigned tasks and minions were spawned!"
    );
  }

  console.log("=".repeat(60));

  setTimeout(() => {
    ws.close();
    process.exit(0);
  }, 2000);
}

ws.on("error", (err) => {
  console.error("WebSocket error:", err.message);
  process.exit(1);
});

// Safety timeout
setTimeout(() => {
  console.log("\n  Timeout — session took too long");
  printSummary();
}, 180_000);
