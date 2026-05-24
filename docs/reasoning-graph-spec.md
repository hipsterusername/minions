# Reasoning Graph - Product and Technical Spec

**Status:** Draft, ready for implementation planning.
**Owner:** TBD.
**Scope:** Leader-controlled reasoning state, validation, user challenge workflow, dashboard visualization, and completion summaries.

---

## 1. Executive summary

The Reasoning Graph is a structured decision and validation surface for agent
work. It lets a Leader externalize the user-legible parts of its task strategy:
outcomes, testable hypotheses, typed evidence, decisions, unresolved risks, and
user challenges.

It does **not** expose private chain-of-thought. It captures concise reasoning
artifacts that are useful for steering, review, and future session reuse.

The MVP should be deliberately narrow:

1. A Leader-owned operational state model.
2. Four core node types: `outcome`, `hypothesis`, `evidence`, `decision`.
3. Optional action bindings to real execution state, especially Minion task IDs.
4. Semantic validation that flags unsupported claims and risky decisions.
5. A focused dashboard view, not a full graph editor.
6. A challenge workflow that turns user objections into auditable revisions.
7. A completion summary persisted with the session.

---

## 2. Why this exists

Minions already exposes task plans, Minion progress, and dashboard output. What
is missing is a durable surface for why the Leader is pursuing a path, which
claims are still weak, and how evidence changed the plan.

Today, that reasoning is spread across transcript text, task cards, dashboard
snippets, and tool calls. Users can miss important assumptions, and reviewers
cannot easily distinguish validated decisions from convenient guesses.

The Reasoning Graph closes that gap by making strategy state explicit without
pretending to reveal hidden model deliberation.

---

## 3. Goals and non-goals

### Goals

1. Represent major task reasoning as structured operational state.
2. Make assumptions, evidence, decisions, unresolved risks, and stale branches
   visible.
3. Bind selected actions to actual execution objects, such as Minion task IDs.
4. Let users challenge or pin reasoning without directly mutating graph data.
5. Validate semantic quality, not just graph topology.
6. Summarize graph state for completion, recovery, and future context.

### Non-goals

- Do not expose private chain-of-thought.
- Do not require every task to use a Reasoning Graph.
- Do not replace the Leader's reasoning with a deterministic rules engine.
- Do not ship a full manual graph editor in MVP.
- Do not build a separate visual canvas that competes with `src/graph.ts`.
- Do not store every micro-decision or rejected thought.

---

## 4. Naming and boundaries

`src/graph.ts` already owns the canvas port/protocol graph. To avoid a lasting
naming collision, implementation modules should use **Reasoning Map** for code
paths while the user-facing feature may still be called Reasoning Graph.

Recommended names:

| Surface | Name |
| --- | --- |
| User-facing feature | Reasoning Graph |
| Shared type module | `shared/reasoning-map.ts` |
| Server tool module | `server/reasoning-map-tools.ts` |
| Server persistence module | `server/reasoning-map-store.ts` |
| Dashboard component helpers | `src/reasoning-map-dashboard.ts` |

---

## 5. When to use it

Use a Reasoning Graph when a task has meaningful uncertainty, branching,
validation cost, user-visible tradeoffs, or decisions that should be reviewed.

Examples:

- A risky refactor with competing approaches.
- Debugging where several hypotheses could explain the symptom.
- Vendor, architecture, or design selection.
- Multi-Minion work where decisions and evidence can drift apart.

Use the no-graph path for simple lookups, formatting, one-file edits, obvious
bug fixes, or anything where graph upkeep would cost more than it returns.

---

## 6. Reasoning artifact boundaries

| Artifact | Captures | Does not capture |
| --- | --- | --- |
| Rationale | User-legible reason for a node or decision | Hidden model deliberation |
| Assumption | Belief relied on without proof | Full uncertainty trace |
| Evidence | Test, citation, code reference, runtime observation, user statement | Vague confidence |
| Decision | Chosen path, reason, and material alternatives | Every rejected micro-option |
| Risk | Known uncertainty or failure mode | Speculative concern without task relevance |
| Challenge | User objection or correction request | Direct graph mutation by the user |

---

## 7. Data model

### 7.1 Core types

```ts
export type ReasoningNodeType =
  | "outcome"
  | "hypothesis"
  | "evidence"
  | "decision";

export type ReasoningNodeState =
  | "proposed"
  | "active"
  | "validated"
  | "refuted"
  | "parked"
  | "stale"
  | "closed";

export type EvidenceStrength = "none" | "weak" | "moderate" | "strong";
export type ClaimBasis = "observed" | "inferred" | "assumed" | "user_confirmed";
export type Confidence = "low" | "medium" | "high";
```

### 7.2 Evidence source

```ts
export type EvidenceSource =
  | "test_result"
  | "code_reference"
  | "user_statement"
  | "external_citation"
  | "runtime_observation"
  | "design_artifact"
  | "agent_assumption";

export interface EvidencePayload {
  source: EvidenceSource;
  strength: EvidenceStrength;
  summary: string;
  handle?: string;
}
```

`handle` is a retrievable pointer such as a file path, test command, URL, task
ID, message ID, or dashboard component ID.

### 7.3 Nodes

```ts
export interface ReasoningNodeBase {
  id: string;
  type: ReasoningNodeType;
  title: string;
  summary: string;
  state: ReasoningNodeState;
  basis: ClaimBasis;
  confidence: Confidence;
  createdAt: string;
  updatedAt: string;
  supersedes?: string;
  risk?: {
    severity: "low" | "medium" | "high" | "critical";
    summary: string;
    resolved: boolean;
  };
  question?: {
    prompt: string;
    resolved: boolean;
  };
}

export interface OutcomeNode extends ReasoningNodeBase {
  type: "outcome";
  successSignal: string;
}

export interface HypothesisNode extends ReasoningNodeBase {
  type: "hypothesis";
  falsifiedBy: string;
}

export interface EvidenceNode extends ReasoningNodeBase {
  type: "evidence";
  evidence: EvidencePayload;
}

export interface DecisionNode extends ReasoningNodeBase {
  type: "decision";
  rationale: string;
  alternatives?: Array<{ title: string; reasonRejected: string }>;
  reversible: boolean;
}
```

Hypotheses require `falsifiedBy` at creation. A hypothesis without a
falsification criterion is invalid.

### 7.4 Edges

```ts
export type ReasoningEdgeKind =
  | "supports"
  | "depends_on"
  | "branches_to"
  | "maps_to";

export interface ReasoningEdge {
  id: string;
  sourceId: string;
  targetId: string;
  kind: ReasoningEdgeKind;
  polarity?: 1 | -1;
  strength?: "weak" | "moderate" | "strong";
  createdAt: string;
}
```

`supports` uses `polarity: 1` for support and `polarity: -1` for refutation.
This avoids near-duplicate edge kinds such as `supports`, `refutes`, and
`validates`.

### 7.5 Action bindings

Action is not a required MVP node type. When an action matters to the reasoning
record, bind it to real execution state.

```ts
export type ActionBinding =
  | { kind: "minion_task"; taskId: string }
  | { kind: "tool_call"; name: string; callId?: string }
  | { kind: "manual" };
```

The dashboard should show bound status from the task/tool when available.

---

## 8. Validation model

Validation checks semantic quality. The goal is to make bad reasoning expensive
to hide, not to make graph shape look tidy.

| Check | Severity |
| --- | --- |
| Hypothesis missing `falsifiedBy` | Error |
| Hypothesis has no supporting or refuting evidence | Warning |
| High confidence with weak or missing evidence | Warning |
| Decision based only on assumptions | Warning |
| Decision made while critical risk is unresolved | Warning |
| Contradictory evidence without resolution | Error |
| Evidence handle is missing for test/code/runtime claims | Warning |
| Evidence is stale relative to later material context | Warning |
| Too many open branches without consolidation | Warning |
| Circular unresolved dependency | Error |

Confidence must be shown with basis. `high + assumed` is allowed only when the
validation report calls it out.

---

## 9. User challenge workflow

Challenge is the MVP steering primitive.

1. User challenges a node.
2. Leader classifies the challenge:
   - `misunderstanding`
   - `missing_evidence`
   - `conflicting_evidence`
   - `changed_requirement`
   - `bad_assumption`
3. Leader resolves by doing one or more of:
   - add evidence
   - revise node
   - mark stale or refuted
   - branch alternative
   - ask clarification
4. Dashboard shows the challenge, status, and resolution.

```ts
export interface ReasoningChallenge {
  id: string;
  nodeId: string;
  userText: string;
  classification?: ChallengeClassification;
  status: "open" | "resolved";
  resolution?: string;
  createdAt: string;
  resolvedAt?: string;
}
```

---

## 10. Dashboard MVP

The default dashboard should be focused, not a full graph.

Required views:

| View | Purpose |
| --- | --- |
| Current Path | Active outcome, dominant hypothesis, strongest evidence, current decision/action |
| Unresolved Risk | Weak evidence, open questions, critical risks |
| Decision View | Decisions, rationale, alternatives, and evidence |
| Audit View | Unsupported claims, stale nodes, contradictions |
| Timeline View | Chronological graph updates |

MVP can render these views with the existing Render DSL:

- `tabs` for views.
- `section` for grouped nodes.
- `table` for validation findings.
- `timeline` for revisions and challenges.
- `kv` for selected node details.
- `callout` for critical validation warnings.
- `checklist` for current path progress.

No custom graph-canvas component is required for v1.

---

## 11. Agent-facing operations

Prefer batched operations to reduce MCP chatter.

```ts
export interface ReasoningMapAgent {
  createMap(seed: OutcomeSeed): ReasoningMapId;
  continueMap(mapId: ReasoningMapId): void;
  applyOps(input: { mapId: ReasoningMapId; ops: ReasoningOp[] }): ReasoningOpResult;
  validate(input: { mapId: ReasoningMapId; scope?: ValidationScope }): ValidationReport;
  challengeNode(input: ChallengeInput): ReasoningChallenge;
  summarize(input: { mapId: ReasoningMapId; budget?: SummaryBudget }): ReasoningSummary;
  closeMap(input: { mapId: ReasoningMapId; summary: string }): void;
}
```

Initial MCP tools:

| Tool | Purpose |
| --- | --- |
| `create_reasoning_map` | Start reasoning state for a non-trivial task |
| `apply_reasoning_ops` | Batch add/update/revise/link operations |
| `validate_reasoning_map` | Return semantic validation report |
| `challenge_reasoning_node` | Record and classify a user challenge |
| `summarize_reasoning_map` | Produce token-budgeted summary |
| `close_reasoning_map` | Persist final summary and close active map |

---

## 12. Persistence and revision semantics

Use append-first semantics:

- Nodes can be updated for metadata and status.
- Material reasoning changes create a new node with `supersedes`.
- Decisions can be revised but not silently overwritten.
- Challenges and validation reports remain auditable.
- Completion summary stores the final current path, major decisions, unresolved
  risks, and evidence handles.

Persistence should be session-scoped for MVP, with a project-level index as a
later phase if reuse proves useful.

---

## 13. Implementation phases

### Phase 0 - Spec and acceptance tests

- Land this spec.
- Add fixtures that describe valid and invalid maps.
- Add contract tests for validation behavior before server tools exist.

### Phase 1 - Shared model and validator

- Add `shared/reasoning-map.ts`.
- Add pure reducer helpers for `ReasoningOp[]`.
- Add validation functions and tests.
- No server or UI wiring yet.

### Phase 2 - Server state and MCP tools

- Add session-owned reasoning map state.
- Add `server/reasoning-map-tools.ts`.
- Persist state on mutation using the same session persistence pattern as task
  and render state.
- Expose tool names to Leader sessions.

### Phase 3 - Leader prompt integration

- Teach the Leader when to use the graph and when to choose the no-graph path.
- Require `falsifiedBy` on hypotheses.
- Require validation before major decisions and before close.
- Add challenge-handling instructions.

### Phase 4 - Dashboard rendering

- Render focused views with the existing Render DSL.
- Add node inspector data.
- Add validation badges and challenge status.
- Avoid custom graph canvas until the operational loop proves useful.

### Phase 5 - Challenge workflow

- Add a user-facing challenge action from dashboard or node UI.
- Route challenge messages to the Leader.
- Record classification and resolution.

### Phase 6 - Completion summary and recovery

- Persist summary on close.
- Inject relevant summary into restarted sessions.
- Add tests for recovery behavior.

---

## 14. Success metrics

| Metric | Why it matters |
| --- | --- |
| Reasoning coverage | Major decisions map to outcomes and evidence |
| Validation debt | Open warnings/errors per active map |
| Unsupported claim rate | Measures graph honesty |
| Challenge resolution rate | User steering produces auditable updates |
| Branch resolution rate | Explored paths end in decision, closure, or parking |
| Reuse rate | Summaries help future sessions |
| Task correction rate | Visible reasoning reduces wrong turns |

---

## 15. Open questions

1. Should the first persistence boundary be per session only, or per task within a
   Leader session?
2. Should users be able to pin assumptions in MVP, or should challenge be the
   only steering primitive?
3. How should stale evidence be detected for long-running sessions?
4. Should graph summaries be injected into prompt context automatically, or only
   when a session is resumed?
5. What threshold determines that a task should use the no-graph path?
