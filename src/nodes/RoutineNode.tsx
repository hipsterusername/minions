/**
 * RoutineNode — Canvas surface for the Routines runtime.
 *
 * Two modes, controlled by the `phase` field on its data:
 *
 *   - **browse** — lists available routines from `.claude-canvas/routines/`,
 *     lets the user supply input values, and triggers `start_routine`.
 *   - **running** — subscribes to `routine_progress` for the spawned runId,
 *     renders phase pills with per-step status, and exposes the most
 *     recent handoff brief plus links to the spawned Leader sessions.
 *
 * Once a run terminates the node stays in `running` mode but flips its
 * action button to "Run again" which returns to `browse` with the inputs
 * pre-filled.
 *
 * Bus contract:
 *   `routine_list`     — reply to a `list_routines` WS request.
 *   `routine_started`  — reply to a `start_routine` WS request.
 *   `routine_progress` — broadcast on every snapshot change.
 *   `routine_aborted`  — reply to an `abort_routine` WS request.
 *   `routine_error`    — surfaced by any of the above on failure.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef } from "react";
import type { NodeRenderProps, RoutineLeaderSpawnEvent } from "../types.ts";
import { registerNodeType } from "../node-registry.ts";
import { ResizeHandle } from "../components/ResizeHandle.tsx";
import { subscribeSocketTopic } from "../use-socket.ts";
import { GLOBAL_TOPIC } from "../../shared/ws-envelope.ts";
import type {
  DagStepState,
  Routine,
  RoutineRunSnapshot,
} from "../../shared/routines/types.ts";

// ── Data shape ─────────────────────────────────────────────

export interface RoutineNodeData {
  /** "browse" before run, "running" after the user clicks Run. */
  phase: "browse" | "running";
  /** Current runId once Run was clicked. */
  runId: string | null;
  /** Cached snapshot — re-rendered with each `routine_progress`. */
  snapshot: RoutineRunSnapshot | null;
  /** Routines listed from disk; populated on mount via `list_routines`. */
  routines: Routine[];
  /** ID of the currently selected routine in browse mode. */
  selectedRoutineId: string | null;
  /** Per-input value bag while the user fills out the form. */
  inputDraft: Record<string, string>;
  /** Most recent error (start_routine, list_routines). */
  error: string | null;
}

export function createRoutineNodeDefaultData(): RoutineNodeData {
  return {
    phase: "browse",
    runId: null,
    snapshot: null,
    routines: [],
    selectedRoutineId: null,
    inputDraft: {},
    error: null,
  };
}

// ── Renderer ───────────────────────────────────────────────

export function RoutineNodeRenderer({
  node,
  onUpdateData,
  socketSend,
  socketSubscribe,
  projectPath,
  onResize,
  onRevealMinion,
  onSpawnLeaderChild,
}: NodeRenderProps) {
  const data = node.data as RoutineNodeData;
  const dataRef = useRef(data);
  dataRef.current = data;

  const update = useCallback(
    (partial: Partial<RoutineNodeData>) => {
      onUpdateData({ ...dataRef.current, ...partial });
    },
    [onUpdateData],
  );

  // ── Bootstrap: ask the server for the list of routines once ──
  useEffect(() => {
    if (!socketSend || !projectPath) return;
    socketSend({
      type: "list_routines",
      cwd: projectPath,
      requestId: `routine-list-${node.id}`,
    });
  }, [socketSend, projectPath, node.id]);

  // ── Subscribe to bus events relevant to this node ──
  useEffect(() => {
    if (!socketSubscribe) return;
    return subscribeSocketTopic(socketSubscribe, GLOBAL_TOPIC, (raw: unknown) => {
      const msg = raw as { type?: string; [k: string]: unknown };
      if (!msg || typeof msg.type !== "string") return;

      if (
        msg.type === "routine_list" &&
        msg["requestId"] === `routine-list-${node.id}`
      ) {
        const list = (msg["routines"] as Routine[]) ?? [];
        update({ routines: list, error: null });
        return;
      }
      if (
        msg.type === "routine_started" &&
        msg["requestId"] === `routine-start-${node.id}`
      ) {
        update({
          phase: "running",
          runId: msg["runId"] as string,
          error: null,
        });
        return;
      }
      if (
        msg.type === "routine_error" &&
        (msg["requestId"] === `routine-start-${node.id}` ||
          msg["requestId"] === `routine-list-${node.id}`)
      ) {
        update({ error: (msg["error"] as string) ?? "Unknown error" });
        return;
      }
      if (msg.type === "routine_progress") {
        const snapshot = msg["snapshot"] as RoutineRunSnapshot | undefined;
        if (!snapshot) return;
        if (snapshot.runId !== dataRef.current.runId) return;
        update({ snapshot });
        return;
      }
      if (msg.type === "routine_step_leader_spawned") {
        const runId = msg["runId"] as string | undefined;
        if (!runId || runId !== dataRef.current.runId) return;
        const event: RoutineLeaderSpawnEvent = {
          runId,
          phaseId: msg["phaseId"] as string,
          stepId: msg["stepId"] as string,
          sessionKey: msg["sessionKey"] as string,
        };
        onSpawnLeaderChild?.(event);
      }
    });
  }, [socketSubscribe, node.id, update, onSpawnLeaderChild]);

  // ── Action: start the selected routine ──
  const startRun = useCallback(() => {
    if (!socketSend || !projectPath) return;
    const routineId = dataRef.current.selectedRoutineId;
    if (!routineId) {
      update({ error: "Pick a routine first." });
      return;
    }
    socketSend({
      type: "start_routine",
      cwd: projectPath,
      routineId,
      routineInputs: dataRef.current.inputDraft,
      requestId: `routine-start-${node.id}`,
    });
  }, [socketSend, projectPath, node.id, update]);

  const abortRun = useCallback(() => {
    if (!socketSend || !dataRef.current.runId) return;
    socketSend({
      type: "abort_routine",
      runId: dataRef.current.runId,
      requestId: `routine-abort-${node.id}`,
    });
  }, [socketSend, node.id]);

  const resetToBrowse = useCallback(() => {
    update({ phase: "browse", runId: null, snapshot: null, error: null });
  }, [update]);

  return (
    <div className="rn-card">
      {onResize && (
        <ResizeHandle
          currentSize={node.size}
          minWidth={360}
          minHeight={300}
          onResize={onResize}
          color="var(--accent)"
        />
      )}
      <RoutineHeader
        phase={data.phase}
        snapshot={data.snapshot}
        onAbort={abortRun}
        onReset={resetToBrowse}
      />
      {data.error && <RoutineError message={data.error} />}
      {data.phase === "browse" ? (
        <BrowseView
          data={data}
          onPickRoutine={(id) =>
            update({
              selectedRoutineId: id,
              inputDraft: defaultInputDraftFor(data.routines, id),
            })
          }
          onChangeInput={(key, value) =>
            update({ inputDraft: { ...data.inputDraft, [key]: value } })
          }
          onStart={startRun}
        />
      ) : (
        <RunningView
          snapshot={data.snapshot}
          {...(onRevealMinion ? { onRevealLeader: onRevealMinion } : {})}
        />
      )}
      <RoutineStyles />
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────

function RoutineHeader({
  phase,
  snapshot,
  onAbort,
  onReset,
}: {
  phase: "browse" | "running";
  snapshot: RoutineRunSnapshot | null;
  onAbort: () => void;
  onReset: () => void;
}) {
  const state = snapshot?.state ?? "pending";
  const isLive = state === "pending" || state === "running";
  return (
    <div className="rn-header">
      <span className="rn-title">
        {phase === "browse" ? "Routines" : (snapshot?.routineName ?? "Routine")}
      </span>
      {phase === "running" && snapshot && (
        <span className={`rn-state rn-state--${state}`}>{state}</span>
      )}
      <span className="rn-spacer" />
      {phase === "running" && isLive && (
        <button className="rn-btn rn-btn--danger" onClick={onAbort}>
          Abort
        </button>
      )}
      {phase === "running" && !isLive && (
        <button className="rn-btn" onClick={onReset}>
          Run again
        </button>
      )}
    </div>
  );
}

function BrowseView({
  data,
  onPickRoutine,
  onChangeInput,
  onStart,
}: {
  data: RoutineNodeData;
  onPickRoutine: (id: string) => void;
  onChangeInput: (key: string, value: string) => void;
  onStart: () => void;
}) {
  const selected = useMemo(
    () => data.routines.find((r) => r.id === data.selectedRoutineId) ?? null,
    [data.routines, data.selectedRoutineId],
  );

  if (data.routines.length === 0) {
    return (
      <div className="rn-empty">
        No routines on disk yet. Add a JSON file to{" "}
        <code>.claude-canvas/routines/</code> or seed one from the CLI.
      </div>
    );
  }

  return (
    <div className="rn-body">
      <div className="rn-label">Routine</div>
      <select
        className="rn-select"
        value={data.selectedRoutineId ?? ""}
        onChange={(e) => onPickRoutine(e.target.value)}
      >
        <option value="">— pick a routine —</option>
        {data.routines.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>

      {selected && (
        <>
          {selected.description && (
            <p className="rn-desc">{selected.description}</p>
          )}
          {selected.inputs.length > 0 && (
            <fieldset className="rn-inputs">
              <legend>Inputs</legend>
              {selected.inputs.map((input) => (
                <label key={input.name} className="rn-input-row">
                  <span>
                    {input.label}
                    {input.required ? " *" : ""}
                  </span>
                  <input
                    className="rn-input"
                    type="text"
                    value={data.inputDraft[input.name] ?? ""}
                    placeholder={input.defaultValue ?? ""}
                    onChange={(e) => onChangeInput(input.name, e.target.value)}
                  />
                </label>
              ))}
            </fieldset>
          )}
          <button className="rn-btn rn-btn--primary" onClick={onStart}>
            Run
          </button>
        </>
      )}
    </div>
  );
}

function RunningView({
  snapshot,
  onRevealLeader,
}: {
  snapshot: RoutineRunSnapshot | null;
  onRevealLeader?: ((sessionKey: string) => void) | undefined;
}) {
  if (!snapshot) {
    return <div className="rn-empty">Spinning up…</div>;
  }
  if (snapshot.mode === "dag" && snapshot.dagSteps) {
    return (
      <DagView
        dagSteps={snapshot.dagSteps}
        error={snapshot.error}
        onRevealLeader={onRevealLeader}
      />
    );
  }
  return <PhasesView snapshot={snapshot} onRevealLeader={onRevealLeader} />;
}

function PhasesView({
  snapshot,
  onRevealLeader,
}: {
  snapshot: RoutineRunSnapshot;
  onRevealLeader?: ((sessionKey: string) => void) | undefined;
}) {
  return (
    <div className="rn-body rn-body--pipeline">
      <InputsPipelineCard inputs={snapshot.inputs} />
      <PipelineEdge state="success" hasHandoff={false} />
      {snapshot.phases.map((phase, idx) => {
        const prev = idx > 0 ? snapshot.phases[idx - 1] : undefined;
        return (
          <Fragment key={phase.phaseId}>
            {idx > 0 && (
              <PipelineEdge
                state={prev?.state ?? "pending"}
                hasHandoff={!!prev?.handoff}
              />
            )}
            <PhasePipelineCard
              phase={phase}
              {...(onRevealLeader ? { onRevealLeader } : {})}
            />
          </Fragment>
        );
      })}
      {snapshot.error && (
        <div className="rn-error rn-error--full">Run failed: {snapshot.error}</div>
      )}
    </div>
  );
}

/**
 * The leftmost card in the pipeline: the user inputs that seed phase 1.
 * Mirrors the editor's flow map, but with run-time *values* shown instead
 * of just declarations.
 */
function InputsPipelineCard({
  inputs,
}: {
  inputs: Readonly<Record<string, string | number | boolean>>;
}) {
  const entries = Object.entries(inputs);
  return (
    <article className="rn-pcard rn-pcard--inputs" aria-label="Inputs">
      <header className="rn-pcard-head">
        <span className="rn-pcard-kind">inputs</span>
        <span className="rn-pcard-title">Inputs</span>
      </header>
      <div className="rn-pcard-body">
        {entries.length === 0 ? (
          <div className="rn-pcard-empty">none</div>
        ) : (
          <ul className="rn-input-pills">
            {entries.map(([k, v]) => (
              <li key={k} className="rn-pill rn-pill--input" title={`${k} = ${String(v)}`}>
                <span className="rn-pill-key">{k}</span>
                <span className="rn-pill-eq">=</span>
                <span className="rn-pill-val">{String(v)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

/**
 * One phase card. Shows step lanes, a state pill, and an inspectable
 * "Context produced" foot when the reducer has emitted the handoff.
 */
function PhasePipelineCard({
  phase,
  onRevealLeader,
}: {
  phase: RoutineRunSnapshot["phases"][number];
  onRevealLeader?: (sessionKey: string) => void;
}) {
  const total = phase.steps.length;
  const done = phase.steps.filter(
    (s) => s.outcome === "success" || s.outcome === "error" || s.outcome === "aborted",
  ).length;
  return (
    <article
      className={`rn-pcard rn-pcard--phase rn-pcard--${phase.state}`}
      aria-label={`Phase ${phase.label}`}
    >
      <header className="rn-pcard-head">
        <span className={`rn-pill rn-pill--${phase.state}`}>{phase.state}</span>
        <span className="rn-pcard-title">{phase.label}</span>
        <span className="rn-pcard-count">
          {done}/{total}
        </span>
      </header>
      <div className="rn-pcard-body">
        <ul className="rn-lanes">
          {phase.steps.map((step) => (
            <StepLane
              key={step.stepId}
              step={step}
              {...(onRevealLeader ? { onRevealLeader } : {})}
            />
          ))}
        </ul>
        {phase.handoff && (
          <HandoffPanel handoff={phase.handoff} />
        )}
      </div>
    </article>
  );
}

function StepLane({
  step,
  onRevealLeader,
}: {
  step: RoutineRunSnapshot["phases"][number]["steps"][number];
  onRevealLeader?: (sessionKey: string) => void;
}) {
  // Visual state derives from outcome (terminal) or live state (in-flight).
  const visualState: string = step.outcome ?? (step.sessionKey ? "running" : "pending");
  return (
    <li className={`rn-lane rn-lane--${visualState}`}>
      <span
        className={`rn-lane-dot rn-lane-dot--${visualState}`}
        aria-hidden
      />
      <span className="rn-lane-label" title={step.label}>
        {step.label}
      </span>
      {step.attempts && step.attempts > 1 && (
        <span className="rn-lane-attempts" title={`${step.attempts} attempts`}>
          ↻{step.attempts}
        </span>
      )}
      {step.sessionKey && onRevealLeader && (
        <button
          className="rn-link"
          onClick={() => onRevealLeader(step.sessionKey!)}
          aria-label={`Open ${step.label} session`}
        >
          open
        </button>
      )}
      {step.summary && (
        <span className="rn-lane-summary" title={step.summary}>
          {step.summary}
        </span>
      )}
      {step.lastError && (
        <span className="rn-lane-error" title={step.lastError}>
          {step.lastError}
        </span>
      )}
    </li>
  );
}

/**
 * Context produced by a phase. Surfaces the *symbolic* references the next
 * phase can address: `{{handoff.brief}}`, every `handoff.steps.<id>.outputs`
 * with output keys when present, plus accumulated facts.
 */
function HandoffPanel({
  handoff,
}: {
  handoff: NonNullable<RoutineRunSnapshot["phases"][number]["handoff"]>;
}) {
  const stepIds = Object.keys(handoff.steps);
  const factKeys = Object.keys(handoff.facts);
  const briefPreview = handoff.brief.split("\n").slice(0, 3).join("\n");
  return (
    <details className="rn-handoff" open>
      <summary>
        <span className="rn-handoff-icon" aria-hidden>
          ↘
        </span>
        Context produced — available downstream
      </summary>
      <div className="rn-handoff-body">
        <div className="rn-handoff-row">
          <span className="rn-handoff-chip rn-handoff-chip--brief">
            handoff.brief
          </span>
          <pre className="rn-handoff-brief" title={handoff.brief}>
            {briefPreview}
          </pre>
        </div>
        {stepIds.length > 0 && (
          <div className="rn-handoff-row">
            <span className="rn-handoff-label">step outputs</span>
            <div className="rn-handoff-chips">
              {stepIds.map((id) => {
                const outputs = handoff.steps[id]?.outputs ?? {};
                const keys = Object.keys(outputs);
                return (
                  <span
                    key={id}
                    className="rn-handoff-chip rn-handoff-chip--step"
                    title={`{{handoff.steps.${id}.summary}}\n{{handoff.steps.${id}.outcome}}\n{{handoff.steps.${id}.outputs.*}}`}
                  >
                    {id}
                    {keys.length > 0 && (
                      <span className="rn-handoff-chip-meta">
                        ·{keys.length} key{keys.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
          </div>
        )}
        {factKeys.length > 0 && (
          <div className="rn-handoff-row">
            <span className="rn-handoff-label">facts</span>
            <div className="rn-handoff-chips">
              {factKeys.map((k) => (
                <span
                  key={k}
                  className="rn-handoff-chip rn-handoff-chip--facts"
                  title={`{{handoff.facts.${k}}}`}
                >
                  {k}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

/**
 * Animated bus between two cards. Pulses while upstream is running and
 * solidifies when handoff has been produced.
 */
function PipelineEdge({
  state,
  hasHandoff,
}: {
  state: string;
  hasHandoff: boolean;
}) {
  const cls = `rn-edge rn-edge--${state}${hasHandoff ? " rn-edge--carrying" : ""}`;
  return (
    <div className={cls} aria-hidden>
      <span className="rn-edge-line" />
      <span className="rn-edge-arrow" />
    </div>
  );
}

function DagView({
  dagSteps,
  error,
  onRevealLeader,
}: {
  dagSteps: DagStepState[];
  error?: string | undefined;
  onRevealLeader?: ((sessionKey: string) => void) | undefined;
}) {
  return (
    <div className="rn-body">
      <ul className="rn-steps rn-steps--dag">
        {dagSteps.map((step) => (
          <li key={step.stepId} className="rn-step">
            <span className={`rn-dot rn-dot--${step.outcome ?? step.state}`} />
            <span className="rn-step-label">{step.label}</span>
            {step.dependsOn.length > 0 && (
              <span className="rn-step-deps">
                ← {step.dependsOn.join(", ")}
              </span>
            )}
            {step.summary && (
              <span className="rn-step-summary">{step.summary}</span>
            )}
            {step.sessionKey && onRevealLeader && (
              <button
                className="rn-link"
                onClick={() => onRevealLeader(step.sessionKey!)}
              >
                open
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && <div className="rn-error">Run failed: {error}</div>}
    </div>
  );
}

function RoutineError({ message }: { message: string }) {
  return <div className="rn-error">{message}</div>;
}

// ── Helpers ────────────────────────────────────────────────

function defaultInputDraftFor(
  routines: Routine[],
  id: string,
): Record<string, string> {
  const routine = routines.find((r) => r.id === id);
  if (!routine) return {};
  const out: Record<string, string> = {};
  for (const input of routine.inputs) {
    if (input.defaultValue !== undefined) {
      out[input.name] = String(input.defaultValue);
    }
  }
  return out;
}

// ── Style island ───────────────────────────────────────────

let stylesInjected = false;
function RoutineStyles() {
  useEffect(() => {
    if (stylesInjected) return;
    stylesInjected = true;
    const el = document.createElement("style");
    el.textContent = ROUTINE_CSS;
    document.head.appendChild(el);
  }, []);
  return null;
}

const ROUTINE_CSS = `
.rn-card {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  overflow: hidden;
  font-size: 12px;
  color: var(--text-primary);
}
.rn-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-default);
  background: var(--bg-secondary);
  flex-shrink: 0;
}
.rn-title { font-weight: 600; }
.rn-spacer { flex: 1; }
.rn-state {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  padding: 2px 6px;
  border-radius: 4px;
  letter-spacing: 0.05em;
}
.rn-state--running { background: var(--info-bg); color: var(--info-color); }
.rn-state--success { background: var(--success-bg); color: var(--status-success); }
.rn-state--error,
.rn-state--aborted { background: var(--error-bg); color: var(--status-error); }
.rn-state--pending { background: var(--muted-bg); color: var(--text-muted); }
.rn-body {
  flex: 1;
  padding: 10px 12px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rn-empty { padding: 20px; color: var(--text-muted); text-align: center; }
.rn-label {
  font-size: 10px;
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}
.rn-select, .rn-input {
  width: 100%;
  padding: 5px 8px;
  border: 1px solid var(--border-default);
  border-radius: 5px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 12px;
}
.rn-desc { color: var(--text-muted); margin: 0; }
.rn-inputs {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 8px 10px;
  margin: 0;
}
.rn-inputs legend {
  padding: 0 4px;
  color: var(--text-muted);
  font-size: 10px;
  text-transform: uppercase;
}
.rn-input-row { display: flex; flex-direction: column; gap: 3px; }
.rn-btn {
  align-self: flex-start;
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid var(--border-default);
  background: var(--bg-secondary);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 12px;
}
.rn-btn:hover { background: var(--state-hover); }
.rn-btn--primary {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}
.rn-btn--danger {
  border-color: var(--status-error);
  color: var(--status-error);
}
.rn-error {
  color: var(--status-error);
  background: var(--error-bg);
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 11px;
}
.rn-phase {
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 8px 10px;
  background: var(--bg-secondary);
}
.rn-phase-head { display: flex; align-items: center; gap: 8px; }
.rn-phase-label { font-weight: 500; }
.rn-pill {
  font-family: var(--font-mono);
  font-size: 9px;
  padding: 2px 6px;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.rn-pill--pending { background: var(--muted-bg); color: var(--text-muted); }
.rn-pill--running { background: var(--info-bg); color: var(--info-color); }
.rn-pill--success { background: var(--success-bg); color: var(--status-success); }
.rn-pill--error,
.rn-pill--skipped { background: var(--error-bg); color: var(--status-error); }
.rn-steps { list-style: none; padding: 0; margin: 6px 0 0; display: flex; flex-direction: column; gap: 4px; }
.rn-step { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.rn-step-label { font-weight: 500; min-width: 80px; }
.rn-step-summary { color: var(--text-muted); font-size: 11px; flex: 1; min-width: 0; }
.rn-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  align-self: center;
}
.rn-dot--pending { background: var(--text-muted); opacity: 0.4; }
.rn-dot--running { background: var(--info-color); opacity: 0.8; }
.rn-dot--success { background: var(--status-success); }
.rn-dot--error,
.rn-dot--skipped,
.rn-dot--aborted { background: var(--status-error); }
.rn-step-deps {
  font-size: 10px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}
.rn-steps--dag { gap: 6px; }
.rn-link {
  background: transparent;
  border: none;
  color: var(--info-color);
  font-size: 10px;
  cursor: pointer;
  padding: 0;
  text-decoration: underline;
}
.rn-handoff {
  margin-top: 6px;
  font-size: 10px;
}
.rn-handoff summary { cursor: pointer; color: var(--text-muted); }
.rn-pre {
  margin: 4px 0 0;
  padding: 8px;
  background: var(--bg-elevated);
  border-radius: 5px;
  font-family: var(--font-mono);
  font-size: 10px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow: auto;
}

/* ── Pipeline view ───────────────────────────────────────────── */
.rn-body--pipeline {
  display: flex;
  flex-direction: row;
  align-items: stretch;
  gap: 0;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 12px 12px;
  scroll-snap-type: x proximity;
}
.rn-pcard {
  flex: 0 0 auto;
  min-width: 220px;
  max-width: 280px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  scroll-snap-align: start;
  transition: box-shadow 0.2s ease, border-color 0.25s ease;
  position: relative;
}
.rn-pcard--inputs {
  background: linear-gradient(180deg, rgba(124,77,255,0.08), var(--bg-secondary) 70%);
  border-color: rgba(124, 77, 255, 0.4);
}
.rn-pcard--running {
  border-color: var(--info-color);
  box-shadow: 0 0 0 2px rgba(14, 165, 233, 0.18);
}
.rn-pcard--success { border-color: var(--status-success); }
.rn-pcard--error,
.rn-pcard--aborted { border-color: var(--status-error); }
.rn-pcard--skipped { opacity: 0.55; }
.rn-pcard-head {
  display: flex;
  align-items: center;
  gap: 6px;
  border-bottom: 1px solid var(--border-default);
  padding-bottom: 6px;
}
.rn-pcard-kind {
  font-family: var(--font-mono);
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}
.rn-pcard-title { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rn-pcard-count {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-muted);
}
.rn-pcard-body { display: flex; flex-direction: column; gap: 6px; }
.rn-pcard-empty { color: var(--text-muted); font-size: 11px; font-style: italic; }
.rn-input-pills {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rn-pill--input {
  background: rgba(124, 77, 255, 0.12);
  color: rgb(124, 77, 255);
  border: 1px solid rgba(124, 77, 255, 0.45);
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 3px 8px;
  text-transform: none;
  letter-spacing: 0;
  font-family: var(--font-mono);
}
.rn-pill-key { font-weight: 600; }
.rn-pill-eq { opacity: 0.6; }
.rn-pill-val {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
  font-weight: 500;
}
.rn-lanes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.rn-lane {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 5px;
  border-left: 2px solid transparent;
  background: var(--bg-primary);
  font-size: 11px;
  flex-wrap: wrap;
}
.rn-lane--running {
  border-left-color: var(--info-color);
  background: rgba(14, 165, 233, 0.08);
}
.rn-lane--success { border-left-color: var(--status-success); }
.rn-lane--error,
.rn-lane--aborted { border-left-color: var(--status-error); }
.rn-lane-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.rn-lane-dot--pending { background: var(--text-muted); opacity: 0.45; }
.rn-lane-dot--running {
  background: var(--info-color);
  box-shadow: 0 0 0 0 rgba(14, 165, 233, 0.5);
  animation: rn-pulse 1.4s infinite cubic-bezier(0.66, 0, 0.34, 1);
}
.rn-lane-dot--success { background: var(--status-success); }
.rn-lane-dot--error,
.rn-lane-dot--aborted { background: var(--status-error); }
.rn-lane-label {
  font-weight: 500;
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.rn-lane-attempts {
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--text-muted);
}
.rn-lane-summary {
  flex: 1 1 100%;
  font-size: 10px;
  color: var(--text-muted);
  padding-left: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.rn-lane-error {
  flex: 1 1 100%;
  font-size: 10px;
  color: var(--status-error);
  padding-left: 13px;
}

/* Edge between cards — animated context bus */
.rn-edge {
  flex: 0 0 38px;
  position: relative;
  align-self: stretch;
  display: flex;
  align-items: center;
  justify-content: center;
}
.rn-edge-line {
  height: 2px;
  width: 100%;
  background: var(--border-default);
  border-radius: 1px;
  position: relative;
  overflow: hidden;
}
.rn-edge-arrow {
  position: absolute;
  right: 4px;
  top: 50%;
  width: 0;
  height: 0;
  border-left: 7px solid var(--border-default);
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  transform: translateY(-50%);
}
.rn-edge--running .rn-edge-line {
  background: var(--info-color);
}
.rn-edge--running .rn-edge-line::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.65) 50%, transparent 100%);
  animation: rn-edge-flow 1.4s linear infinite;
}
.rn-edge--running .rn-edge-arrow { border-left-color: var(--info-color); }
.rn-edge--success .rn-edge-line { background: var(--status-success); }
.rn-edge--success .rn-edge-arrow { border-left-color: var(--status-success); }
.rn-edge--error .rn-edge-line,
.rn-edge--aborted .rn-edge-line { background: var(--status-error); }
.rn-edge--error .rn-edge-arrow,
.rn-edge--aborted .rn-edge-arrow { border-left-color: var(--status-error); }
.rn-edge--carrying .rn-edge-line {
  height: 3px;
  box-shadow: 0 0 6px currentColor;
  color: var(--status-success);
}

/* Handoff inspector */
.rn-handoff-icon {
  font-family: var(--font-mono);
  margin-right: 4px;
  color: var(--info-color);
}
.rn-handoff-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 6px;
  padding: 8px;
  background: var(--bg-elevated);
  border-radius: 5px;
}
.rn-handoff-row { display: flex; flex-direction: column; gap: 3px; }
.rn-handoff-label {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}
.rn-handoff-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.rn-handoff-chip {
  font-family: var(--font-mono);
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.rn-handoff-chip--brief {
  background: rgba(14, 165, 233, 0.14);
  color: rgb(14, 165, 233);
  border: 1px solid rgba(14, 165, 233, 0.45);
  align-self: flex-start;
}
.rn-handoff-chip--step {
  background: rgba(16, 185, 129, 0.14);
  color: rgb(16, 185, 129);
  border: 1px solid rgba(16, 185, 129, 0.45);
}
.rn-handoff-chip--facts {
  background: rgba(168, 85, 247, 0.14);
  color: rgb(168, 85, 247);
  border: 1px solid rgba(168, 85, 247, 0.45);
}
.rn-handoff-chip-meta { opacity: 0.7; font-weight: 500; }
.rn-handoff-brief {
  margin: 2px 0 0;
  font-family: var(--font-mono);
  font-size: 10px;
  background: var(--bg-secondary);
  padding: 6px;
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 80px;
  overflow: hidden;
  position: relative;
  color: var(--text-secondary);
}
.rn-error--full {
  flex: 1 0 100%;
  margin-top: 8px;
}

@keyframes rn-pulse {
  0% { box-shadow: 0 0 0 0 rgba(14, 165, 233, 0.5); }
  70% { box-shadow: 0 0 0 6px rgba(14, 165, 233, 0); }
  100% { box-shadow: 0 0 0 0 rgba(14, 165, 233, 0); }
}
@keyframes rn-edge-flow {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}
@media (prefers-reduced-motion: reduce) {
  .rn-lane-dot--running { animation: none; }
  .rn-edge--running .rn-edge-line::after { animation: none; }
}
`;

// ── Register ──────────────────────────────────────────────

registerNodeType({
  type: "routine",
  label: "Routine",
  defaultSize: { width: 460, height: 500 },
  render: RoutineNodeRenderer,
  userCreatable: true,
  ownsChildrenOfType: ["leader"],
  isContainer: true,
});
