import { describe, expect, it } from "vitest";
import { CodexRawAdapter, MinionGraphAdapter, MinionSingleAdapter, type CodexProcessLauncher, type MinionsProtocolClient } from "./index.js";
import type { ParticipantRunSpec, RunHandle } from "../../schemas/index.js";

const run: ParticipantRunSpec = { schemaVersion: 1, runId: "run", idempotencyKey: "same-run", taskId: "task", prompt: "fix it", workspace: { id: "workspace", mountPath: "/tmp/workspace" }, limits: { maxTotalTokens: 10, executionTimeoutMs: 10, preparationTimeoutMs: 10, gradingTimeoutMs: 10 }, configuration: {}, visibleAssets: [] };
const handle: RunHandle = { schemaVersion: 1, adapterId: "minion-single", handleId: "h", runId: "run", createdAt: "2026-01-01T00:00:00.000Z" };

describe("external adapters", () => {
  it("fails Minions preflight when enforced single-agent controls are absent", async () => {
    const client: MinionsProtocolClient = { probe: async () => ({ protocolVersion: 1, capabilities: { dedicated_state: true }, evidence: ["fake"] }), launch: async () => handle, events: async function* () {}, snapshot: async () => ({ schemaVersion: 1, handle, state: "terminal", terminalOutcome: "completed", participants: [], observedAt: handle.createdAt }), cancel: async () => ({ schemaVersion: 1, handle, reason: "cancelled", accepted: true, stoppedAt: handle.createdAt, descendantsAccountedFor: true }), collect: async () => ({ schemaVersion: 1, handle, artifacts: [], provenance: {}, usageCoverage: "complete", logTruncated: false }) };
    const p = await new MinionSingleAdapter(client).preflight({ schemaVersion: 1, adapterId: "minion-single", settings: {}, requiredCapabilities: [] });
    expect(p.supported).toBe(false); expect(p.limitations).toContain("missing required capability: role_tool_restrictions");
  });
  it("enforces idempotent direct Codex launch and exposes an inspectable durable handle", async () => {
    let launches = 0; let launchArgs: string[] = [];
    const launcher: CodexProcessLauncher = { probe: async () => ({ executable: "codex", version: "test", supportsJson: true, supportsEphemeral: true, supportsDisableDelegation: true }), launch: async (input) => { launches++; launchArgs = input.args; return { id: "proc", events: (async function* () { yield { type: "turn.completed", turn_id: "turn" }; })(), inspect: async () => ({ terminal: false, outcome: null }), stop: async () => true, collect: async () => [] }; } };
    const adapter = new CodexRawAdapter(launcher); const first = await adapter.start(run); const second = await adapter.start(run);
    expect(second).toEqual(first); expect(launches).toBe(1); expect((await adapter.inspect(first)).participants).toHaveLength(1);
    expect(launchArgs).toEqual(expect.arrayContaining(["--disable", "multi_agent", "--strict-config", "--ephemeral"]));
    expect((await adapter.stop(first, "cancelled")).descendantsAccountedFor).toBe(true);
  });
  it("requires graph-specific self-decomposition and terminal-quiescence capabilities", async () => {
    const p = await new MinionGraphAdapter(undefined).preflight({ schemaVersion: 1, adapterId: "minion-graph", settings: {}, requiredCapabilities: [] });
    expect(p.supported).toBe(false); expect(p.limitations[0]).toMatch(/external Minions protocol client/);
  });
});
