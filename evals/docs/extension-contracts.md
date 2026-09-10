# Extension contracts

`@minions/agent-evals` is a standalone Node package. Its runtime boundary is
`evals/src/**`; it never imports application internals. Minions adapters start a separately prepared application process and communicate externally.
The package exports contracts from `@minions/agent-evals` and runtime schemas
from `@minions/agent-evals/schemas`. The executable is
`agent-evals` (`src/cli/main.ts` → `dist/src/cli/main.js`).

## Ownership and exports

Foundation owns `schemas/index.ts` and `src/core/{contracts,registry,utils,index}.ts`.
Runner code may import only these public modules. Adapter, isolation, grader,
report, fixture, and CLI branches own their own implementations and register
instances rather than extending core switch statements.

```ts
import {
  ExtensionRegistry, type ExecutionAdapter, type IsolationBackend,
  type Grader, type ReportView, type TaskDefinition, type ExperimentPlan,
  type ExperimentCell, type ResultRecord
} from "@minions/agent-evals";
import { TaskDefinitionSchema, RunEventSchema } from "@minions/agent-evals/schemas";
```

All persisted records have `schemaVersion: 1`, use strict runtime schemas, and
unknown versions fail validation. IDs are stable identifiers; registry keys are
the pair `id@version`, preventing a later extension from silently replacing an
earlier implementation.

## Signatures

```ts
interface ExecutionAdapter {
  readonly id: string; readonly version: string;
  preflight(config: AdapterConfig): Promise<CapabilityReport>;
  start(run: ParticipantRunSpec): Promise<RunHandle>;
  observe(handle: RunHandle, afterSequence?: number): AsyncIterable<RunEvent>;
  inspect(handle: RunHandle): Promise<ExecutionSnapshot>;
  stop(handle: RunHandle, reason: StopReason): Promise<StopReceipt>;
  collect(handle: RunHandle): Promise<CollectedExecution>;
}
interface IsolationBackend {
  readonly id: string; readonly version: string;
  preflight(spec: IsolationSpec): Promise<CapabilityReport>;
  provision(spec: IsolationSpec): Promise<{ workspaceId: string; mountPath: string }>;
  teardown(workspaceId: string): Promise<void>;
}
interface Grader { readonly id: string; readonly version: string;
  grade(input: FrozenSubmission, context: GraderContext): Promise<GradeResult>; }
interface ReportView { readonly id: string; readonly version: string;
  render(input: { results: readonly unknown[]; metrics: readonly MetricDefinition[] }): Promise<{ html: string; warnings: string[] }>; }
```

`ParticipantRunSpec` carries only participant-visible prompt/assets, workspace,
limits, and settings. It intentionally has no grader/oracle path. `RunHandle`
is opaque, durable, and tied to an idempotency key. Event/usage/result schemas
preserve coverage, source identity, lifecycle state, protocol outcome, and
separate execution versus grade outcomes. Usage rejects inconsistent totals and
reasoning values that exceed output tokens.

## Registration rules

Each extension validates its config with the matching schema, runs preflight
before any paid launch, and registers with `ExtensionRegistry<T>`. Unknown IDs,
versions, and unsupported capabilities are errors, never fallbacks. Report views
consume persisted `ResultRecord` and `MetricDefinition` records only; they must
not inspect live sessions. Metric IDs are namespaced (`namespace.metric`),
versioned, and cannot overwrite reserved core fields.
