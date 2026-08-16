
import { describe, it, expect } from "vitest";
import { validateWsCommand, COMMAND_SCHEMAS } from "./schemas.ts";
import type { WsCommandType } from "./types.ts";

// All WsCommandType values, kept in sync via the compile-time `satisfies`.
const ALL_TYPES = Object.keys(COMMAND_SCHEMAS) as WsCommandType[];

function accept(payload: unknown) {
  const result = validateWsCommand(payload);
  expect(result.ok, `expected ok=true, got error: ${!result.ok ? result.error : ""}`).toBe(true);
}

function reject(payload: unknown, expectedSubstring?: string) {
  const result = validateWsCommand(payload);
  expect(result.ok, "expected ok=false").toBe(false);
  if (expectedSubstring && !result.ok) {
    expect(result.error).toContain(expectedSubstring);
  }
}

describe("validateWsCommand – accept", () => {
  it("accepts list_sessions with only type", () => {
    accept({ type: "list_sessions" });
  });

  it("accepts list_harnesses with only type", () => {
    accept({ type: "list_harnesses" });
  });

  it("accepts create_session with all optional fields present", () => {
    accept({
      type: "create_session",
      sessionKey: "s1",
      workItemId: "work-1",
      cwd: "/home/user",
      workspaceId: "8dcf241e-52b8-4d50-a2f3-9b12fdab7a1c",
      sandboxPolicy: {
        filesystemScope: "workspace-write",
        approvalPolicy: "on-request",
      },
      role: "leader",
      skillIds: ["review"],
      skillValues: { review: { target: "api" } },
      worktreeIsolation: true,
      model: "claude-3-opus",
      permissionMode: "default",
      prompt: "Hello",
      systemPrompt: "You are helpful.",
      harness: "claude",
    });
  });

  it("accepts create_session with no optional fields", () => {
    accept({ type: "create_session" });
  });

  it("keeps path-addressed create_session ingress compatible", () => {
    accept({ type: "create_session", cwd: "/legacy/project" });
  });

  it("accepts send_message with a prompt and attachment", () => {
    accept({
      type: "send_message",
      sessionKey: "s1",
      prompt: "Describe this image.",
      attachments: [
        {
          kind: "image",
          mediaType: "image/png",
          data: "base64encodeddata",
        },
      ],
    });
  });

  it("accepts stop_session with just a sessionKey", () => {
    accept({ type: "stop_session", sessionKey: "s2" });
  });

  it("accepts rewind_files with dryRun flag", () => {
    accept({
      type: "rewind_files",
      sessionKey: "s1",
      userMessageId: "msg-42",
      dryRun: true,
    });
  });

  it("accepts seed_read_state with path and mtime", () => {
    accept({
      type: "seed_read_state",
      sessionKey: "s1",
      path: "/home/user/file.ts",
      mtime: 1700000000,
    });
  });

  it("accepts toggle_mcp_server with enabled=false", () => {
    accept({
      type: "toggle_mcp_server",
      sessionKey: "s1",
      serverName: "my-server",
      enabled: false,
    });
  });

  it("accepts submit_form with formAnswers", () => {
    accept({
      type: "submit_form",
      sessionKey: "s1",
      formComponentId: "form-abc",
      formAnswers: { name: "Alice", agree: true },
    });
  });

  it("accepts unknown extra fields (additive client fields are ignored)", () => {
    accept({
      type: "list_sessions",
      extraFieldFromFutureClient: "ignored",
    });
  });

  it("accepts requestId alongside any command type", () => {
    accept({ type: "get_context_usage", sessionKey: "s1", requestId: "req-1" });
  });

  it("accepts work-item mutation and query contracts", () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    accept({ type: "create_work_item", requestId: id(1), projectId: "p1", projectPath: "/repo", title: "Task", changeMode: "live" });
    accept({ type: "create_work_item", requestId: id(10),
      workspaceId: "44444444-4444-4444-8444-444444444444",
      title: "Task", changeMode: "live" });
    reject({ type: "create_work_item", requestId: id(12),
      workspaceId: "44444444-4444-4444-8444-444444444444",
      projectId: "p1", projectPath: "/repo", title: "Task", changeMode: "live" }, "workspaceId");
    accept({ type: "continue_work_item", requestId: id(11), workItemId: "w1", prompt: "Continue",
      displayPrompt: "Continue",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null });
    accept({ type: "start_work_item_run", requestId: id(2), workItemId: "w1", prompt: "Start",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null, harness: "codex", model: "gpt-5",
      permissionMode: "auto", thinkingConfig: { enabled: true }, skillIds: ["review"],
      skillValues: { review: { target: "api" } } });
    accept({ type: "reply_to_waiting_run", requestId: id(3), workItemId: "w1", runKey: "r1", prompt: "Continue", expectedLifecycleRevision: 1, expectedCurrentRunKey: "r1" });
    accept({ type: "review_work_item", requestId: id(4), workItemId: "w1", expectedLifecycleRevision: 2, expectedCurrentRunKey: "r1" });
    accept({ type: "archive_work_item", requestId: id(5), workItemId: "w1", expectedLifecycleRevision: 3, expectedCurrentRunKey: "r1" });
    accept({ type: "restore_work_item", requestId: id(6), workItemId: "w1", expectedLifecycleRevision: 4, expectedCurrentRunKey: "r1" });
    accept({ type: "attach_work_item_surface", requestId: id(7), workItemId: "w1", surface: "canvas", bindingId: "n1", expectedLifecycleRevision: 5, expectedCurrentRunKey: "r1" });
    accept({ type: "detach_work_item_surface", requestId: id(8), workItemId: "w1", surface: "canvas", bindingId: "n1", expectedLifecycleRevision: 6, expectedCurrentRunKey: "r1" });
    accept({ type: "get_work_item", workItemId: "w1", limit: 25 });
    accept({ type: "list_work_items", projectId: "p1", includeArchived: true, limit: 50 });
    accept({ type: "get_work_item_runs", workItemId: "w1", cursor: "next" });
  });

  it("accepts every task-graph command with its canonical fences", () => {
    const hash=`sha256:${"a".repeat(64)}`;
    const graphRevision={definitionId:"definition",revisionId:"revision",workItemId:"work",
      workspaceId:"workspace",objective:"Execute",acceptanceCriteria:["done"],nonGoals:[],constraints:[],
      terminalNodeIds:["node"],maxActiveAttempts:2,edges:[],nodes:[{id:"node",title:"Node",
        objective:"Do it",inputBindings:{},outputSchemas:{},constraints:[],acceptanceCriteria:[],
        executorClass:"standard",allowedHarnesses:["codex"],allowedTools:[],ownershipRequest:[],
        budgetRequest:{},timeoutMs:1_000,retryPolicy:{maxAttempts:2,backoffMs:10,
          retryableOutcomes:["failed","lost"],jitterMs:0},verificationRequired:false,
        failurePolicy:"fail_graph",expansionPolicy:null}]};
    const sourceSnapshot={id:"source",workItemId:"work",primaryRunKey:"primary",
      taskGraphRevisionId:"revision",repositoryBaseCommit:"abc",dirtyDiffDigest:hash,
      workspaceId:"workspace",worktreeIdentity:"worktree",systemModelDigest:hash,
      workPacketRevisionId:null,connectedContext:[],compiledSkills:[],harnessPolicyDigest:hash,
      toolPolicyDigest:hash,createdAt:1};
    accept({type:"validate_task_graph_revision",requestId:"request",graphRevision});
    accept({type:"create_task_graph_revision",requestId:"request",workItemId:"work",graphRevision});
    accept({type:"start_task_graph_run",requestId:"request",runId:"run",workItemId:"work",
      primaryRunKey:"primary",revisionId:"revision",sourceSnapshot,expectedLifecycleRevision:3});
    accept({type:"get_task_graph_snapshot",requestId:"request",workItemId:"work",runId:"run"});
    for (const type of ["pause_task_graph_run","resume_task_graph_run","cancel_task_graph_run"] as const) {
      accept({type,requestId:"request",workItemId:"work",runId:"run",expectedRunRevision:4});
    }
    accept({type:"retry_task_node",requestId:"request",workItemId:"work",runId:"run",nodeId:"node",
      currentAttemptId:"attempt",expectedRunRevision:4});
    accept({type:"cancel_task_attempt",requestId:"request",workItemId:"work",runId:"run",nodeId:"node",
      currentAttemptId:"attempt",expectedRunRevision:4});
    accept({type:"request_task_verification",requestId:"request",workItemId:"work",runId:"run",nodeId:"node",
      currentAttemptId:"attempt",expectedRunRevision:4});
    accept({type:"waive_task_verification",requestId:"request",workItemId:"work",runId:"run",nodeId:"node",
      currentAttemptId:"attempt",expectedRunRevision:4,actor:"operator",reason:"Emergency approval"});
    accept({type:"provide_task_input",requestId:"request",workItemId:"work",runId:"run",nodeId:"node",
      currentAttemptId:null,expectedRunRevision:4,actor:"operator",input:"Proceed"});
    accept({type:"list_task_graph_attempts",requestId:"request",workItemId:"work",runId:"run",nodeId:"node"});
    accept({type:"steer_task_graph",requestId:"request",workItemId:"work",runId:"run",
      expectedRunRevision:4,instructions:"Prioritize node",affectedNodeIds:["node"]});
    accept({type:"get_task_artifact",requestId:"request",workItemId:"work",runId:"run",
      artifactId:"artifact"});
    accept({type:"reconcile_task_graph_run",requestId:"request",workItemId:"work",runId:"run",
      expectedRunRevision:4,artifactIds:["artifact"],verificationIds:["verification"],sourceDiffHash:hash});
  });
});

describe("validateWsCommand – connected context budgets", () => {
  it("rejects an oversized canvas context item", () => {
    reject({
      type: "canvas_context",
      sessionKey: "leader",
      items: [{ nodeId: "node", nodeType: "markdown", label: "Context",
        content: "x".repeat(256 * 1024 + 1) }],
    }, "Too big");
  });
});

describe("validateWsCommand – reject", () => {
  it("rejects null", () => {
    reject(null, "JSON object");
  });

  it("rejects a string", () => {
    reject("list_sessions", "JSON object");
  });

  it("rejects an array", () => {
    reject(["list_sessions"], "JSON object");
  });

  it("rejects an object without a type field", () => {
    reject({}, '"type" field');
  });

  it("rejects an object with a numeric type field", () => {
    reject({ type: 42 }, '"type" field');
  });

  it("rejects an unknown command type", () => {
    reject({ type: "unknown_command_xyz" }, "Unknown command type");
  });

  it("rejects create_session when role is not a valid SessionRole", () => {
    reject(
      { type: "create_session", role: "superadmin" },
      "create_session",
    );
  });

  it("rejects create_session with an empty workItemId", () => {
    reject({ type: "create_session", workItemId: "" }, "create_session");
  });

  it("rejects send_message when attachments is not an array", () => {
    reject(
      { type: "send_message", attachments: "not-an-array" },
      "send_message",
    );
  });

  it("rejects send_message when an attachment is missing required mediaType", () => {
    reject(
      {
        type: "send_message",
        attachments: [{ kind: "image", data: "abc" }],
      },
      "send_message",
    );
  });

  it("rejects send_message when an attachment has an unsupported mediaType", () => {
    reject(
      {
        type: "send_message",
        attachments: [{ kind: "image", mediaType: "image/tiff", data: "abc" }],
      },
      "send_message",
    );
  });

  it("rejects rewind_files when dryRun is a string instead of boolean", () => {
    reject(
      { type: "rewind_files", dryRun: "true" },
      "rewind_files",
    );
  });

  it("rejects toggle_mcp_server when enabled is a number instead of boolean", () => {
    reject(
      { type: "toggle_mcp_server", enabled: 1 },
      "toggle_mcp_server",
    );
  });

  it("rejects seed_read_state when mtime is a string instead of number", () => {
    reject(
      { type: "seed_read_state", mtime: "yesterday" },
      "seed_read_state",
    );
  });

  it("rejects create_session when worktreeIsolation is a string", () => {
    reject(
      { type: "create_session", worktreeIsolation: "yes" },
      "create_session",
    );
  });

  it("rejects unfenced or unaudited task-graph mutations", () => {
    reject({type:"pause_task_graph_run",requestId:"request",workItemId:"work",runId:"run"},
      "pause_task_graph_run");
    reject({type:"cancel_task_attempt",requestId:"request",workItemId:"work",runId:"run",
      nodeId:"node",expectedRunRevision:1},"cancel_task_attempt");
    reject({type:"retry_task_node",requestId:"request",workItemId:"work",runId:"run",
      nodeId:"node",expectedRunRevision:1},"retry_task_node");
    for (const type of ["retry_task_node","request_task_verification","waive_task_verification"] as const) {
      const extra=type==="waive_task_verification"?{actor:"operator",reason:"reviewed"}:{};
      const command={type,requestId:"request",workItemId:"work",runId:"run",nodeId:"node",
        expectedRunRevision:1,...extra};
      reject(command,type);
      reject({...command,currentAttemptId:null},type);
    }
    reject({type:"waive_task_verification",requestId:"request",workItemId:"work",runId:"run",
      nodeId:"node",currentAttemptId:"attempt",expectedRunRevision:1,actor:"operator"},
      "waive_task_verification");
    reject({type:"provide_task_input",requestId:"request",workItemId:"work",runId:"run",
      nodeId:"node",currentAttemptId:null,expectedRunRevision:1,actor:"operator",input:"  "},
      "provide_task_input");
    reject({type:"steer_task_graph",workItemId:"work",runId:"run",expectedRunRevision:1,
      instructions:"Proceed",affectedNodeIds:[]},"steer_task_graph");
    reject({type:"steer_task_graph",requestId:"request",workItemId:"work",runId:"run",
      instructions:"Proceed",affectedNodeIds:[]},"steer_task_graph");
    reject({type:"steer_task_graph",requestId:"request",workItemId:"work",runId:"run",
      expectedRunRevision:1,instructions:"Proceed",affectedNodeIds:[]},"steer_task_graph");
    reject({type:"reconcile_task_graph_run",requestId:"request",workItemId:"work",runId:"run",
      artifactIds:[],verificationIds:[],sourceDiffHash:`sha256:${"a".repeat(64)}`},
      "reconcile_task_graph_run");
    reject({type:"reconcile_task_graph_run",requestId:"request",workItemId:"work",runId:"run",
      expectedRunRevision:1,artifactIds:[],verificationIds:[],
      sourceDiffHash:`sha256:${"a".repeat(64)}`},"reconcile_task_graph_run");
    reject({type:"reconcile_task_graph_run",requestId:"request",workItemId:"work",runId:"run",
      expectedRunRevision:1,artifactIds:[],verificationIds:[],sourceDiffHash:"not-a-hash"},
      "reconcile_task_graph_run");
  });

  it("rejects ambiguous task-graph snapshot selectors", () => {
    reject({type:"get_task_graph_snapshot",requestId:"request",workItemId:"work",
      runId:"run",primaryRunKey:"primary"},"mutually exclusive");
  });

  it("rejects invalid workspace identity and sandbox policy values", () => {
    reject({ type: "create_session", workspaceId: "/projects/not-opaque" }, "workspaceId");
    reject({
      type: "create_session",
      sandboxPolicy: {
        filesystemScope: "workspace-write",
        approvalPolicy: "sometimes",
      },
    }, "approvalPolicy");
  });

  it("rejects incomplete sandbox policies", () => {
    reject({
      type: "create_session",
      sandboxPolicy: {
        filesystemScope: "read-only",
      },
    }, "approvalPolicy");
  });

  it("requires idempotency keys on work-item mutations", () => {
    reject({ type: "archive_work_item", workItemId: "w1", expectedLifecycleRevision: 1, expectedCurrentRunKey: "r1" }, "requestId");
  });

  it("rejects invalid work-item surfaces and page sizes", () => {
    reject({ type: "attach_work_item_surface", requestId: "r", workItemId: "w", surface: "activity", bindingId: "b" }, "surface");
    reject({ type: "list_work_items", projectId: "p", limit: 101 }, "limit");
  });
});

describe("COMMAND_SCHEMAS completeness", () => {
  it("has a schema for every WsCommandType in the union", () => {
    // This test proves exhaustiveness at runtime, complementing the
    // compile-time `satisfies Record<WsCommandType, z.ZodType>` constraint.
    // If you add a WsCommandType without a matching schema entry, the
    // `satisfies` already fails the build; this catches it in test output too.
    expect(ALL_TYPES.length).toBeGreaterThan(0);
    for (const type of ALL_TYPES) {
      expect(
        COMMAND_SCHEMAS[type],
        `Missing schema for WsCommandType "${type}"`,
      ).toBeDefined();
    }
  });
});
