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

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { NodeRenderProps, RoutineLeaderSpawnEvent } from "../types.ts";
import { registerNodeType } from "../node-registry.ts";
import { ResizeHandle } from "../components/ResizeHandle.tsx";
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
    return socketSubscribe((raw: unknown) => {
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
                    type={input.type === "number" ? "number" : "text"}
                    value={data.inputDraft[input.name] ?? ""}
                    placeholder={
                      input.defaultValue !== undefined
                        ? String(input.defaultValue)
                        : ""
                    }
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
  onRevealLeader?: (sessionKey: string) => void;
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
  onRevealLeader?: (sessionKey: string) => void;
}) {
  return (
    <div className="rn-body">
      {snapshot.phases.map((phase) => (
        <div key={phase.phaseId} className="rn-phase">
          <div className="rn-phase-head">
            <span className={`rn-pill rn-pill--${phase.state}`}>
              {phase.state}
            </span>
            <span className="rn-phase-label">{phase.label}</span>
          </div>
          <ul className="rn-steps">
            {phase.steps.map((step) => (
              <li key={step.stepId} className="rn-step">
                <span className={`rn-dot rn-dot--${step.outcome ?? "pending"}`} />
                <span className="rn-step-label">{step.label}</span>
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
          {phase.handoff && (
            <details className="rn-handoff">
              <summary>handoff brief</summary>
              <pre className="rn-pre">{phase.handoff.brief}</pre>
            </details>
          )}
        </div>
      ))}
      {snapshot.error && (
        <div className="rn-error">Run failed: {snapshot.error}</div>
      )}
    </div>
  );
}

function DagView({
  dagSteps,
  error,
  onRevealLeader,
}: {
  dagSteps: DagStepState[];
  error?: string;
  onRevealLeader?: (sessionKey: string) => void;
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
