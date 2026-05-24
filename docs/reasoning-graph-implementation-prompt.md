# Reasoning Graph - Implementation Planning Prompt

**Purpose:** reusable prompt/process for a Leader session that will implement
the Reasoning Graph feature from `docs/reasoning-graph-spec.md`.

Use this document as the orchestration prompt after the spec is accepted. It is
written to drive planning, delegation, validation, and integration without
assuming all implementation details up front.

---

## Leader prompt

You are implementing the Reasoning Graph feature for Minions.

Read these files first:

1. `CLAUDE.md`
2. `context.md`
3. `docs/reasoning-graph-spec.md`
4. `server/agents/leader.ts`
5. `server/task-tools.ts` and `server/task-tools/*.ts`
6. `server/render-tools.ts`
7. `server/session-persist.ts`
8. `shared/render-dsl.ts`
9. `src/nodes/RenderNode.tsx`

Important constraints:

- The user-facing feature is called Reasoning Graph, but code modules should use
  `reasoning-map` to avoid confusion with the existing canvas graph in
  `src/graph.ts`.
- Do not expose private chain-of-thought. Store only user-legible reasoning
  artifacts.
- Keep v1 focused. Do not build a full graph editor or custom graph canvas.
- Prefer the existing Render DSL for the dashboard view.
- Prefer pure shared model/validation code before server or UI wiring.
- Do not mix unrelated refactors into this feature.
- Respect dirty worktree changes from other work.

Before implementing, produce an implementation plan with:

1. File-level impact map.
2. Data model and validation acceptance criteria.
3. MCP tool contract.
4. Persistence strategy.
5. Leader prompt changes.
6. Dashboard rendering approach.
7. Test plan by phase.
8. Explicit deferrals.

Use Minions task orchestration:

- Call `set_task_name`.
- Register the phases below with `plan_task`.
- Delegate independent tasks only when each has a disjoint file ownership area.
- Keep shared type/schema work on the critical path local unless it blocks no
  one.
- Require every Minion to list changed files and tests run.
- Review Minion changes before integration.

---

## Recommended task breakdown

### Task 1 - Shared reasoning-map model and validation

**Owner:** local Leader or one Minion if isolated.

**Files:**

- `shared/reasoning-map.ts`
- `shared/reasoning-map.test.ts`

**Build:**

- Reasoning map types.
- `ReasoningOp` union.
- `applyReasoningOps`.
- `validateReasoningMap`.
- Fixtures for valid and invalid maps.

**Acceptance criteria:**

- Hypothesis without `falsifiedBy` returns an error.
- High confidence with weak/no evidence returns a warning.
- Decision based only on assumptions returns a warning.
- Contradictory evidence returns an error.
- Circular unresolved dependency returns an error.
- Typecheck passes for shared code.

---

### Task 2 - Server state, persistence, and MCP tools

**Owner:** Minion or Leader after Task 1 lands.

**Files:**

- `server/reasoning-map-tools.ts`
- `server/reasoning-map-tools.test.ts`
- `server/session-persist.ts`
- `server/session-persist.test.ts`
- `server/db.ts`
- `server/agents/types.ts`

**Build:**

- Session-owned reasoning map state.
- Tool factory returning normalized MCP tool definitions.
- Write-through persistence on mutation.
- Hydration on session restart.

**Tools to expose:**

- `create_reasoning_map`
- `apply_reasoning_ops`
- `validate_reasoning_map`
- `challenge_reasoning_node`
- `summarize_reasoning_map`
- `close_reasoning_map`

**Acceptance criteria:**

- Tool handlers reject invalid ops with useful errors.
- Tool handlers preserve append-first revision semantics.
- Existing task/render persistence tests continue to pass.
- Restart hydration restores active reasoning map state.

---

### Task 3 - Leader prompt and allowed tool wiring

**Owner:** Leader.

**Files:**

- `server/agents/leader.ts`
- Relevant tests for Leader tool groups/prompt if present.

**Build:**

- Add reasoning-map tools to Leader tool groups and allowed MCP tool names.
- Prompt instructions for when to use the graph and no-graph path.
- Prompt instructions for hypothesis falsifiability, validation before major
  decisions, and challenge handling.

**Acceptance criteria:**

- Leader prompt names the tools and constraints accurately.
- Existing Leader/Minion orchestration instructions remain intact.
- Tests pin tool group exposure.

---

### Task 4 - Dashboard rendering helpers

**Owner:** Minion with frontend ownership.

**Files:**

- `src/reasoning-map-dashboard.ts`
- `src/reasoning-map-dashboard.test.ts`
- Optional small changes in `src/nodes/RenderNode.tsx` only if needed.

**Build:**

- Convert reasoning map state and validation report into Render DSL components.
- Support Current Path, Unresolved Risk, Decision, Audit, and Timeline views.
- Keep components stable-id friendly for `render_patch`.

**Acceptance criteria:**

- Output conforms to `shared/render-dsl.ts`.
- Tests cover empty state, active path, validation findings, and challenges.
- No custom graph canvas in v1.

---

### Task 5 - User challenge routing

**Owner:** Minion or Leader depending on UI scope.

**Files to inspect before committing scope:**

- `src/nodes/RenderNode.tsx`
- `src/render-flatten.ts`
- `src/use-socket.ts`
- `server/commands/send-message.ts`
- `server/commands/types.ts`

**Build:**

- Decide whether MVP challenge is a dashboard-generated user message or a new
  explicit command.
- Route challenge text and node ID back to the Leader.
- Ensure Leader can call `challenge_reasoning_node` and resolve it.

**Acceptance criteria:**

- User can challenge a visible node without editing the graph directly.
- Challenge is recorded with classification and resolution.
- The dashboard can show open and resolved challenges.

---

### Task 6 - Completion summary and recovery

**Owner:** Leader.

**Files:**

- `server/session-host-context-recovery.ts`
- `server/session-persist.ts`
- Relevant recovery tests.

**Build:**

- Include closed reasoning summary in restart context.
- Preserve unresolved risks and final decisions.
- Keep summary token-budgeted.

**Acceptance criteria:**

- Restarted sessions can see prior graph summary.
- Closed maps do not re-open unless the Leader explicitly continues them.
- Tests cover recovery from persisted summary.

---

## Planning checklist

Before code changes:

- [ ] Confirm whether persistence is per session or per task for v1.
- [ ] Confirm whether challenge is implemented through existing message flow or
      a new command.
- [ ] Confirm exact storage shape in SQLite.
- [ ] Confirm whether dashboard rendering is agent-driven via Render DSL tools
      or app-driven from persisted state.
- [ ] Confirm minimal public UI surface for challenge.

During implementation:

- [ ] Land shared model and validation before server wiring.
- [ ] Keep reasoning-map code separate from canvas graph code.
- [ ] Add tests with each phase.
- [ ] Validate with `pnpm typecheck` and targeted `pnpm vitest` commands.
- [ ] Run broader `pnpm verify` before requesting approval if feasible.

Deferrals:

- Full manual graph editing.
- Custom graph canvas.
- Reusable graph templates.
- Cross-project graph search.
- Sophisticated computed confidence.
- Advanced stale-evidence heuristics.

---

## First planning turn template

Use this as the first Leader response when starting implementation:

```text
I will implement the Reasoning Graph as a session-owned Reasoning Map, keeping
the first build focused on typed state, validation, Leader tools, dashboard
rendering, and challenge handling.

I will first inspect the existing task tools, render tools, persistence, and
Leader prompt. Then I will produce a file-level implementation plan and split
the work into phases with clear ownership. I will avoid modifying the existing
canvas graph system except where routing or display integration requires it.

Planned phases:
1. Shared model and validator.
2. Server reasoning-map tools and persistence.
3. Leader prompt and tool wiring.
4. Render DSL dashboard views.
5. Challenge workflow.
6. Completion summary and recovery.

I will defer full graph editing, custom graph canvas rendering, reusable graph
patterns, and cross-project persistence until the core loop proves useful.
```
