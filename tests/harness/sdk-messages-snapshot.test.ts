/**
 * Snapshot baseline for `sdkToDisplayMessages` against every fixture.
 *
 * For each JSONL fixture in `tests/fixtures/sdk-message-streams/`,
 * replay it through the harness, run every `sdk_event` message through
 * `sdkToDisplayMessages`, and assert the resulting `DisplayMessage[]`
 * matches an inline snapshot.
 *
 * **Why:** the three node files (LeaderNode, MinionNode,
 * ClaudeSessionNode) all funnel SDK events through this conversion
 * before rendering. Locking the conversion's behaviour fixture-by-
 * fixture is the cheapest insurance the upcoming SessionHost
 * extraction doesn't accidentally change what the UI shows.
 *
 * **Stability:** `id` and `timestamp` are non-deterministic by design
 * (UUID + Date.now()). They're stripped from every DisplayMessage
 * before snapshotting so reruns produce identical output.
 *
 * If a snapshot diff comes back unexpected during the SessionHost
 * extraction, that means behaviour drifted — stop, decide if it's
 * intended, and update the snapshot deliberately.
 */

import { describe, expect, it } from "vitest";

import {
  type DisplayMessage,
  sdkToDisplayMessages,
} from "../../src/sdk-messages.ts";
import type { ServerMessage, SdkMessage } from "../../src/use-socket.ts";
import { loadFixture } from "./ws-replay.ts";

/**
 * Strip volatile fields (`id`, `timestamp`) from a DisplayMessage so
 * snapshots are stable. Returns a new object — never mutates input.
 */
function stripVolatile(
  m: DisplayMessage,
): Omit<DisplayMessage, "id" | "timestamp"> {
  const { id: _id, timestamp: _ts, ...rest } = m;
  return rest;
}

/**
 * Replay a fixture and run every `sdk_event` through the conversion.
 * Returns the flattened DisplayMessage[] across all events, with
 * volatile fields stripped.
 */
function snapshotFixture(
  relativePath: string,
): Omit<DisplayMessage, "id" | "timestamp">[] {
  const entries = loadFixture(relativePath);
  const out: Omit<DisplayMessage, "id" | "timestamp">[] = [];

  for (const entry of entries) {
    const msg: ServerMessage = entry.message;
    if (msg.type !== "sdk_event") continue;
    const sdk: SdkMessage = msg.message;
    for (const display of sdkToDisplayMessages(sdk, "test")) {
      out.push(stripVolatile(display));
    }
  }
  return out;
}

describe("sdk-messages: snapshot baseline against fixtures", () => {
  it("leader-plan-and-delegate.jsonl produces the expected DisplayMessage stream", () => {
    expect(snapshotFixture("leader-plan-and-delegate.jsonl")).toMatchInlineSnapshot(`
      [
        {
          "content": "Session on claude-opus-4-5",
          "role": "system",
          "sdkUuid": "u-init-0001",
        },
        {
          "content": "Two independent tasks. I'll plan both, then delegate the first to a minion.",
          "role": "thinking",
          "sdkUuid": "u-asst-0002",
        },
        {
          "content": "I'll plan the two tasks and delegate the first.",
          "role": "assistant",
          "sdkUuid": "u-asst-0003",
        },
        {
          "content": "mcp__task-manager__set_task_name",
          "role": "tool",
          "sdkUuid": "u-asst-0004",
          "toolInput": {
            "name": "Plan and delegate",
          },
          "toolName": "mcp__task-manager__set_task_name",
        },
        {
          "content": "mcp__task-manager__plan_task",
          "role": "tool",
          "sdkUuid": "u-asst-0005",
          "toolInput": {
            "description": "Do the first thing",
            "priority": "high",
            "taskId": "task-a",
            "title": "First task",
          },
          "toolName": "mcp__task-manager__plan_task",
        },
        {
          "content": "mcp__task-manager__plan_task",
          "role": "tool",
          "sdkUuid": "u-asst-0006",
          "toolInput": {
            "description": "Do the second thing",
            "priority": "medium",
            "taskId": "task-b",
            "title": "Second task",
          },
          "toolName": "mcp__task-manager__plan_task",
        },
        {
          "content": "mcp__task-manager__assign_task",
          "role": "tool",
          "sdkUuid": "u-asst-0007",
          "toolInput": {
            "prompt": "Do the first thing",
            "taskId": "task-a",
          },
          "toolName": "mcp__task-manager__assign_task",
        },
        {
          "content": "Delegated \`task-a\` to a minion. I'll handle \`task-b\` myself next.",
          "role": "assistant",
          "sdkUuid": "u-asst-0008",
        },
        {
          "content": "Planned 2 tasks and delegated 1.",
          "role": "result",
          "sdkUuid": "u-result-0009",
          "suffix": "8.6s · $0.0288",
        },
      ]
    `);
  });

  it("leader-thinking-and-text.jsonl splits a single assistant message into 3 DisplayMessages", () => {
    const out = snapshotFixture("leader-thinking-and-text.jsonl");
    expect(out).toMatchInlineSnapshot(`
      [
        {
          "content": "Session on claude-opus-4-5",
          "role": "system",
          "sdkUuid": "u-init-0001",
        },
        {
          "content": "I should read the file before deciding.",
          "role": "thinking",
          "sdkUuid": "u-asst-0002",
        },
        {
          "content": "Looking at the source now.",
          "role": "assistant",
          "sdkUuid": "u-asst-0002",
        },
        {
          "content": "Read",
          "role": "tool",
          "sdkUuid": "u-asst-0002",
          "toolInput": {
            "file_path": "/repo/src/index.ts",
          },
          "toolName": "Read",
        },
        {
          "content": "Read complete.",
          "role": "result",
          "sdkUuid": "u-result-0003",
          "suffix": "1.2s · $0.0042",
        },
      ]
    `);

    // The three sdkUuids for the assistant blocks should all share the
    // SDK uuid — they originate from one message that was split.
    const fromAssistant = out.filter((m) => m.sdkUuid === "u-asst-0002");
    expect(fromAssistant.map((m) => m.role)).toEqual([
      "thinking",
      "assistant",
      "tool",
    ]);
  });

  it("leader-stream-then-final.jsonl drops stream_event partials and surfaces the final message", () => {
    expect(snapshotFixture("leader-stream-then-final.jsonl")).toMatchInlineSnapshot(`
      [
        {
          "content": "Session on claude-opus-4-5",
          "role": "system",
          "sdkUuid": "u-init-0001",
        },
        {
          "content": "Hello world",
          "role": "assistant",
          "sdkUuid": "u-asst-0005",
        },
        {
          "content": "Hello world",
          "role": "result",
          "sdkUuid": "u-result-0006",
          "suffix": "0.6s · $0.0009",
        },
      ]
    `);
  });

  it("minion-completes-task.jsonl produces text + report_step + tool_progress + report_done + result", () => {
    expect(snapshotFixture("minion-completes-task.jsonl")).toMatchInlineSnapshot(`
      [
        {
          "content": "Session on claude-sonnet-4-5",
          "role": "system",
          "sdkUuid": "u-init-0001",
        },
        {
          "content": "Starting task-a. I'll read the file then patch it.",
          "role": "assistant",
          "sdkUuid": "u-asst-0002",
        },
        {
          "content": "mcp__minion__report_step",
          "role": "tool",
          "sdkUuid": "u-asst-0003",
          "toolInput": {
            "summary": "Reading source file",
          },
          "toolName": "mcp__minion__report_step",
        },
        {
          "content": "Read (0.3s)",
          "role": "tool",
          "sdkUuid": "u-prog-0004",
          "toolName": "Read",
        },
        {
          "content": "mcp__minion__report_done",
          "role": "tool",
          "sdkUuid": "u-asst-0005",
          "toolInput": {
            "details": "Updated header copy in src/index.ts",
            "summary": "Patched 1 file",
          },
          "toolName": "mcp__minion__report_done",
        },
        {
          "content": "Patched 1 file",
          "role": "result",
          "sdkUuid": "u-result-0006",
          "suffix": "4.2s · $0.0114",
        },
      ]
    `);
  });

  it("claude-session-basic.jsonl renders the collapsible tool-group sequence", () => {
    expect(snapshotFixture("claude-session-basic.jsonl")).toMatchInlineSnapshot(`
      [
        {
          "content": "Session on claude-opus-4-5",
          "role": "system",
          "sdkUuid": "u-init-0001",
        },
        {
          "content": "I'll run ls.",
          "role": "assistant",
          "sdkUuid": "u-asst-0003",
        },
        {
          "content": "Bash",
          "role": "tool",
          "sdkUuid": "u-asst-0003",
          "toolInput": {
            "command": "ls /repo",
          },
          "toolName": "Bash",
        },
        {
          "content": "Bash (0.4s)",
          "role": "tool",
          "sdkUuid": "u-prog-0004",
          "toolName": "Bash",
        },
        {
          "content": "Bash: listed 3 entries",
          "role": "system",
          "sdkUuid": "u-summ-0006",
        },
        {
          "content": "Three top-level entries: src, README.md, package.json.",
          "role": "assistant",
          "sdkUuid": "u-asst-0007",
        },
        {
          "content": "Three top-level entries: src, README.md, package.json.",
          "role": "result",
          "sdkUuid": "u-result-0008",
          "suffix": "1.8s · $0.0061",
        },
      ]
    `);
  });
});
