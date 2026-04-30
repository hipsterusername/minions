/**
 * Lifecycle helpers for `SessionHost`.
 *
 * Contains the pure-ish pieces of `SessionHost.start()` that are large
 * enough to warrant their own home:
 *   - `ensureWorktree` — resolves the effective cwd/worktree for this run
 *   - `buildQueryOptions` — assembles the options bag passed to `query()`
 *   - `processSdkMessage` — the per-message body of the `for await` loop
 *
 * Kept as free functions that take an explicit `SessionHost` reference so
 * the class file stays under the architecture line-count ceiling.
 */

import type {
  AgentType,
  AgentTypeContext,
  McpServerResult,
} from "./agents/index.ts";
import type { Bus } from "./bus.ts";
import { createWorktree, isGitRepo, type WorktreeInfo } from "./worktree.ts";
import {
  enrichSystemPromptForWorktree,
  modelSupportsAdaptive,
  resolveModelId,
  type BufferedEvent,
} from "./session-host-config.ts";
import type { SessionHost, StartSessionOptions } from "./session-host.ts";
import { execSync } from "node:child_process";

function resolveClaudePath(): string {
  if (process.env["CLAUDE_CODE_PATH"]) return process.env["CLAUDE_CODE_PATH"];
  try {
    return execSync("which claude", { encoding: "utf8" }).trim();
  } catch {
    return "claude";
  }
}

const CLAUDE_EXECUTABLE = resolveClaudePath();

const CODE_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "Agent",
  "WebFetch",
  "WebSearch",
];

/**
 * Ensure the host has the correct cwd + worktree wiring before the SDK
 * query opens. Mutates `host` in place and emits bus events on failure.
 *
 * Returns the effective cwd the SDK should use.
 */
export async function ensureWorktree(
  host: SessionHost,
  opts: StartSessionOptions,
  bus: Bus,
  agentType: AgentType,
): Promise<string> {
  let effectiveCwd = opts.cwd;

  // Inherit parent worktree for minion sessions
  if (opts.parentWorktree) {
    host.worktree = opts.parentWorktree;
    host.cwd = opts.parentWorktree.path;
    effectiveCwd = opts.parentWorktree.path;
    console.log(
      `[worktree] Minion ${host.id} inheriting worktree ${opts.parentWorktree.branch} at ${opts.parentWorktree.path}`,
    );
  } else {
    host.cwd = effectiveCwd;
  }

  if (!(agentType.wantsWorktree && host.worktreeIsolation)) {
    return effectiveCwd;
  }

  if (host.worktree && !opts.parentWorktree) {
    // Resume: reuse existing worktree
    host.cwd = host.worktree.path;
    return host.worktree.path;
  }

  if (opts.parentWorktree) return effectiveCwd;

  try {
    const inGitRepo = await isGitRepo(effectiveCwd);
    if (inGitRepo) {
      const worktreeInfo = await createWorktree(effectiveCwd, host.id);
      host.worktree = worktreeInfo;
      host.cwd = worktreeInfo.path;
      bus.emitToSession(host.id, {
        type: "worktree_created",
        sessionKey: host.id,
        worktreePath: worktreeInfo.path,
        branch: worktreeInfo.branch,
      });
      return worktreeInfo.path;
    }
    console.warn(
      `[worktree] ${host.id}: not a git repo — isolation unavailable`,
    );
    bus.emitToSession(host.id, {
      type: "worktree_failed",
      sessionKey: host.id,
      error:
        "Project is not a git repository. Worktree isolation is unavailable.",
    });
    return effectiveCwd;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      `[worktree] Failed to create worktree for ${host.id}: ${errMsg}`,
    );
    bus.emitToSession(host.id, {
      type: "worktree_failed",
      sessionKey: host.id,
      error: `Worktree creation failed: ${errMsg}`,
    });
    host.worktreeIsolation = false;
    return effectiveCwd;
  }
}

/** Parameters for `buildQueryOptions`. */
export interface QueryOptionsInput {
  host: SessionHost;
  opts: StartSessionOptions;
  agentType: AgentType;
  agentCtx: AgentTypeContext;
  mcpResult: McpServerResult;
  abortController: AbortController;
}

/** Assemble the options bag that gets passed to the SDK's `query()`. */
export function buildQueryOptions(
  input: QueryOptionsInput,
): { options: Record<string, unknown>; allowedTools: string[] } {
  const { host, opts, agentType, agentCtx, mcpResult, abortController } = input;
  const externalToolNames = opts.externalMcpToolNames ?? [];
  const allowedTools = [...CODE_TOOLS, ...mcpResult.mcpToolNames, ...externalToolNames];

  const options: Record<string, unknown> = {
    cwd: host.cwd,
    resume: opts.resumeId,
    allowedTools,
    disallowedTools: [],
    permissionMode: "auto",
    abortController,
    includePartialMessages: true,
    promptSuggestions: true,
    pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
  };

  const allMcpServers = {
    ...mcpResult.mcpServers,
    ...(opts.externalMcpServers ?? {}),
  };
  if (Object.keys(allMcpServers).length > 0) {
    options["mcpServers"] = allMcpServers;
  }

  const basePrompt = agentType.buildSystemPrompt(agentCtx, opts.systemPrompt);
  if (basePrompt) {
    options["systemPrompt"] = host.worktree
      ? enrichSystemPromptForWorktree(
          basePrompt,
          host.worktree,
          agentType.id === "minion",
        )
      : basePrompt;
  }

  if (host.model) {
    options["model"] = resolveModelId(host.model);
  }

  if (host.thinkingConfig?.enabled && modelSupportsAdaptive(host.model)) {
    options["thinking"] = {
      type: "adaptive",
      display: host.thinkingConfig.display,
    };
    options["effort"] = host.thinkingConfig.effort;
  }

  return { options, allowedTools };
}

/**
 * Handle a single SDK event: capture init data, fan the event out, and
 * rebroadcast Agent-tool subagent signals as canvas-aware events.
 */
export function processSdkMessage(
  host: SessionHost,
  bus: Bus,
  agentType: AgentType,
  agentCtx: AgentTypeContext,
  message: unknown,
): void {
  const m = message as { type?: string; subtype?: string } & Record<
    string,
    unknown
  >;

  // Capture init data from system/init event
  if (m.type === "system" && m.subtype === "init") {
    host.sessionId = m["session_id"] as string;
    host.model = (m["model"] as string) ?? null;
    host.permissionMode = (m["permissionMode"] as string) ?? null;
    host.initData = {
      tools: m["tools"],
      model: m["model"],
      mcp_servers: m["mcp_servers"],
      permissionMode: m["permissionMode"],
      slash_commands: m["slash_commands"],
      skills: m["skills"],
      claude_code_version: m["claude_code_version"],
    };
    // Persist the SDK session id immediately. Otherwise a session that
    // never reaches a `result` (e.g. user stops mid-turn, server crashes)
    // would lose its resume id and have to start fresh next time.
    host.persist();
  }

  // Forward all SDK events to the bus
  const sdkEvent: BufferedEvent = {
    type: "sdk_event",
    sessionKey: host.id,
    message,
    timestamp: Date.now(),
  };
  host.bufferEvent(sdkEvent);
  bus.emitToSession(host.id, sdkEvent);

  // Detect Agent-tool subagent events and rebroadcast as canvas-aware events
  if (agentType.detectsSubagents && m.type === "system") {
    if (m.subtype === "task_started") {
      const taskId =
        (m["task_id"] as string) ?? `agent-${Date.now().toString(36)}`;
      const description = (m["description"] as string) ?? "Subagent task";
      bus.emitToSession(host.id, {
        type: "agent_spawned",
        leaderSessionKey: host.id,
        taskId,
        title: description,
        description,
        timestamp: Date.now(),
      });
    }
    if (m.subtype === "task_notification") {
      const taskId = (m["task_id"] as string) ?? "";
      const status = (m["status"] as string) ?? "completed";
      const summary = (m["summary"] as string) ?? "";
      bus.emitToSession(host.id, {
        type: "agent_task_update",
        leaderSessionKey: host.id,
        taskId,
        status,
        summary,
        timestamp: Date.now(),
      });
    }
  }

  // Update session metadata on result
  if (m.type === "result") {
    host.status = "idle";
    host.totalCost = (m["total_cost_usd"] as number) ?? host.totalCost;
    host.turns = (m["num_turns"] as number) ?? host.turns;
    host.persist();
    const resultStatusEvent: BufferedEvent = {
      type: "session_status",
      sessionKey: host.id,
      status: "idle",
      sessionId: host.sessionId ?? undefined,
      timestamp: Date.now(),
    };
    host.bufferEvent(resultStatusEvent);
    bus.emitToSession(host.id, resultStatusEvent);

    if (agentType.onComplete) {
      agentType.onComplete(agentCtx, m);
    }
  }
}

/**
 * Type export for the agent's MCP-server construction result shape.
 * Re-exported here rather than pulled from the full agent module to
 * keep the import arrow into `session-host.ts` narrow.
 */
export type { WorktreeInfo };
