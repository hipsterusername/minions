/**
 * DialecticNode — an experimental node that runs two planner agents in a
 * structured, cache-optimized back-and-forth and synthesizes a final plan.
 *
 * The node itself holds no agent session; it drives the server-side dialectic
 * orchestrator via `start_dialectic` / `stop_dialectic` and renders the
 * coordinator's `dialectic_update` event stream. The two planners are always
 * distinct server sessions (keys `-A` / `-B`), even when the same model and
 * harness are chosen for both.
 *
 * Gated behind the `dialectic` feature flag (off by default).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import {
  ArrowDown,
  Check,
  ChevronLeft,
  ChevronRight,
  Eye,
  History,
  MessageSquareText,
  Scale,
} from "lucide-react";
import { registerNodeType } from "../node-registry.ts";
import type { NodeRenderProps } from "../types.ts";
import { subscribeSocketTopic } from "../use-socket.ts";
import { sessionTopic } from "../../shared/ws-envelope.ts";
import { FLAG_DIALECTIC } from "../feature-flags.ts";
import {
  DIALECTIC_EVENT_TYPE,
  DIALECTIC_MODES,
  type DialecticConfig,
  type DialecticEvent,
  type DialecticMode,
  type DialecticRunStatus,
  type DialecticSpeaker,
  type DialecticTurnContext,
  type PlannerConfig,
  MAX_DIALECTIC_ROUNDS,
  MIN_DIALECTIC_ROUNDS,
  createDefaultDialecticConfig,
  dialecticSessionKeys,
  normalizeDialecticConfig,
  normalizeRounds,
} from "../../shared/dialectic.ts";
import { useHarnessList } from "../use-harness-list.tsx";
import { DEFAULT_HARNESS_NAME, type HarnessInfo } from "../harness-list.ts";

/** Encode a harness+model pair into a single <option> value. */
function encodePlanner(harness: string, model: string): string {
  return `${harness} ${model}`;
}

/** Decode an <option> value back into a harness+model pair. */
function decodePlanner(value: string): PlannerConfig {
  const sep = value.indexOf(" ");
  if (sep === -1) return { harness: DEFAULT_HARNESS_NAME, model: value };
  return { harness: value.slice(0, sep), model: value.slice(sep + 1) };
}

// ── Data ────────────────────────────────────────────────────────────────────

export interface DialecticTurnRecord {
  speaker: DialecticSpeaker;
  round: number;
  text: string;
  context?: DialecticTurnContext;
  isError?: boolean;
}

export interface DialecticData {
  topic: string;
  config: DialecticConfig;
  status: DialecticRunStatus;
  turns: DialecticTurnRecord[];
  activeSpeaker: DialecticSpeaker | null;
  activeRound: number | null;
  synthesis: string | null;
  error: string | null;
}

export function createDialecticDefaultData(): DialecticData {
  return {
    topic: "",
    config: createDefaultDialecticConfig(),
    status: "idle",
    turns: [],
    activeSpeaker: null,
    activeRound: null,
    synthesis: null,
    error: null,
  };
}

/** Fill defaults / coerce persisted-or-partial node data into a full shape. */
function normalizeData(raw: unknown): DialecticData {
  const base = createDialecticDefaultData();
  if (!raw || typeof raw !== "object") return base;
  const o = raw as Partial<DialecticData>;
  return {
    topic: typeof o.topic === "string" ? o.topic : base.topic,
    config: normalizeDialecticConfig(o.config),
    status: (o.status as DialecticRunStatus) ?? base.status,
    turns: Array.isArray(o.turns) ? o.turns : base.turns,
    activeSpeaker: o.activeSpeaker ?? null,
    activeRound: typeof o.activeRound === "number" ? o.activeRound : null,
    synthesis: typeof o.synthesis === "string" ? o.synthesis : null,
    error: typeof o.error === "string" ? o.error : null,
  };
}

/** Fold a coordinator event into node data. */
export function reduce(data: DialecticData, event: DialecticEvent): DialecticData {
  switch (event.kind) {
    case "run_status":
      return {
        ...data,
        status: event.status,
        error: event.status === "error" ? event.error ?? "Dialectic failed" : null,
        activeSpeaker: event.status === "running" ? data.activeSpeaker : null,
      };
    case "turn_started":
      return {
        ...data,
        turns: [
          ...data.turns.filter(
            (t) => !(t.speaker === event.speaker && t.round === event.round),
          ),
          {
            speaker: event.speaker,
            round: event.round,
            text: "",
            ...(event.context ? { context: event.context } : {}),
          },
        ],
        activeSpeaker: event.speaker,
        activeRound: event.round,
      };
    case "turn_completed": {
      // Idempotent: replace a matching (speaker, round) turn if it already exists.
      const same = (t: DialecticTurnRecord) => t.speaker === event.speaker && t.round === event.round;
      const started = data.turns.find(same);
      const rest = data.turns.filter((t) => !same(t));
      const record: DialecticTurnRecord = {
        speaker: event.speaker,
        round: event.round,
        text: event.text,
        ...(started?.context ? { context: started.context } : {}),
      };
      if (event.isError !== undefined) record.isError = event.isError;
      return { ...data, turns: [...rest, record], activeSpeaker: null };
    }
    case "synthesis":
      return { ...data, synthesis: event.document };
    default:
      return data;
  }
}

// ── Component ────────────────────────────────────────────────────────────────

function DialecticNodeRenderer(props: NodeRenderProps): ReactElement {
  const { node, onUpdateData, socketSend, socketSubscribe, projectPath, projectId } = props;
  const data = useMemo(() => normalizeData(node.data), [node.data]);
  const dataRef = useRef(data);
  dataRef.current = data;

  const keys = useMemo(() => dialecticSessionKeys(node.id), [node.id]);
  const running = data.status === "running";
  const dialogueTurns = data.turns.filter((t) => t.speaker === "A" || t.speaker === "B");
  const hasRun = dialogueTurns.length > 0 || running || Boolean(data.synthesis);
  const [setupOpen, setSetupOpen] = useState(!hasRun);

  useEffect(() => {
    if (running) setSetupOpen(false);
  }, [running]);

  const patch = useCallback(
    (partial: Partial<DialecticData>) => {
      onUpdateData({ ...dataRef.current, ...partial });
    },
    [onUpdateData],
  );

  const patchConfig = useCallback(
    (partial: Partial<DialecticConfig>) => {
      onUpdateData({ ...dataRef.current, config: { ...dataRef.current.config, ...partial } });
    },
    [onUpdateData],
  );

  // Subscribe to coordinator progress events.
  useEffect(() => {
    if (!socketSubscribe) return;
    const unsubscribe = subscribeSocketTopic(
      socketSubscribe,
      sessionTopic(keys.coordinator),
      (msg: unknown) => {
        const m = msg as { type?: string; sessionKey?: string; event?: DialecticEvent };
        if (m.type !== DIALECTIC_EVENT_TYPE || !m.event) return;
        onUpdateData(reduce(dataRef.current, m.event));
      },
    );
    return unsubscribe;
  }, [socketSubscribe, keys.coordinator, onUpdateData]);

  const start = useCallback(() => {
    const topic = dataRef.current.topic.trim();
    if (!topic || !socketSend) return;
    onUpdateData({
      ...dataRef.current,
      status: "running",
      turns: [],
      synthesis: null,
      error: null,
      activeSpeaker: null,
      activeRound: null,
    });
    socketSend({
      type: "start_dialectic",
      sessionKey: node.id,
      ...(projectId ? { workspaceId: projectId } : { cwd: projectPath }),
      prompt: topic,
      dialecticConfig: dataRef.current.config,
    });
  }, [socketSend, onUpdateData, node.id, projectPath, projectId]);

  const stop = useCallback(() => {
    socketSend?.({ type: "stop_dialectic", sessionKey: node.id });
    patch({ status: "stopped", activeSpeaker: null });
  }, [socketSend, node.id, patch]);

  return (
    <div
      style={S.root}
      data-testid="dialectic-node"
      data-scroll-capture
      tabIndex={0}
      aria-label="Dialectic workspace"
    >
      <header style={S.header}>
        <div style={S.titleGroup}>
          <span style={S.titleIcon} aria-hidden="true">
            <Scale size={14} strokeWidth={2} />
          </span>
          <span>
            <span style={S.title}>Dialectic</span>
            <span style={S.subtitle}>Two-model review</span>
          </span>
        </div>
        <StatusBadge status={data.status} />
      </header>

      {!running && (
        <details
          style={S.configDisclosure}
          open={setupOpen}
          onToggle={(event) => setSetupOpen(event.currentTarget.open)}
          data-no-drag
        >
          <summary style={S.configSummary}>
            <span>{hasRun ? "Run setup" : "Configure dialectic"}</span>
            {hasRun && (
              <span style={S.configSummaryMeta}>
                {DIALECTIC_MODES.find((m) => m.id === data.config.mode)?.label} ·{" "}
                {data.config.rounds} {data.config.rounds === 1 ? "round" : "rounds"}
              </span>
            )}
          </summary>
          <div style={S.config}>
            <label style={S.field}>
              <span style={S.label}>Topic</span>
              <textarea
                style={S.textarea}
                value={data.topic}
                placeholder="What should the two planners work through?"
                onChange={(e) => patch({ topic: e.target.value })}
              />
            </label>

            <div style={S.row}>
              <label style={S.field}>
                <span style={S.label}>Structure</span>
                <select
                  style={S.select}
                  value={data.config.mode}
                  onChange={(e) => patchConfig({ mode: e.target.value as DialecticMode })}
                >
                  {DIALECTIC_MODES.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ ...S.field, maxWidth: 90 }}>
                <span style={S.label}>Rounds</span>
                <input
                  style={S.select}
                  type="number"
                  min={MIN_DIALECTIC_ROUNDS}
                  max={MAX_DIALECTIC_ROUNDS}
                  value={data.config.rounds}
                  onChange={(e) => patchConfig({ rounds: normalizeRounds(Number(e.target.value)) })}
                />
              </label>
            </div>

            <div style={S.hint}>{DIALECTIC_MODES.find((m) => m.id === data.config.mode)?.description}</div>

            <div style={S.row}>
              <PlannerPicker
                label="Planner A"
                value={data.config.plannerA}
                onChange={(planner) => patchConfig({ plannerA: planner })}
              />
              <PlannerPicker
                label="Planner B"
                value={data.config.plannerB}
                onChange={(planner) => patchConfig({ plannerB: planner })}
              />
            </div>
          </div>
        </details>
      )}

      <div style={S.actions}>
        {running ? (
          <button style={S.stopBtn} onClick={stop}>
            Stop
          </button>
        ) : (
          <button style={S.startBtn} onClick={start} disabled={!data.topic.trim()}>
            {data.turns.length > 0 || data.synthesis ? "Restart dialectic" : "Start dialectic"}
          </button>
        )}
        {data.activeSpeaker && (
          <span style={S.active} aria-live="polite">
            <span style={S.pulseDot} />
            {speakerName(data.config.mode, data.activeSpeaker)} preparing a shared response · round{" "}
            {(data.activeRound ?? 0) + 1}
          </span>
        )}
      </div>

      {data.error && <div style={S.error}>{data.error}</div>}

      {hasRun && (
        <>
          <RunOverview data={data} />
          <div style={S.disclosureNote}>
            <Eye size={13} aria-hidden="true" />
            <span>
              This view shows model outputs and the exact context passed between sessions.
              Private hidden chain-of-thought is not available.
            </span>
          </div>
          <ExchangeTimeline
            turns={dialogueTurns}
            config={data.config}
            activeSpeaker={data.activeSpeaker}
            activeRound={data.activeRound}
          />
        </>
      )}

      {data.synthesis && (
        <div style={S.synthesis}>
          <div style={S.synthesisTitle}>Synthesized plan</div>
          <div style={S.synthesisBody}>{data.synthesis}</div>
        </div>
      )}
    </div>
  );
}

/**
 * Harness-aware model picker for one planner. Options are sourced from the
 * shared harness registry (`useHarnessList`) — the same inventory that drives
 * the Leader node's model dropdown — so any harness/model registered on the
 * server (Claude, Codex/GPT, …) surfaces here automatically. Each option
 * carries both the harness name and the concrete model id, so switching to a
 * GPT model also switches the planner's harness in one selection.
 */
function PlannerPicker(props: {
  label: string;
  value: PlannerConfig;
  onChange: (planner: PlannerConfig) => void;
}): ReactElement {
  const { harnesses } = useHarnessList();
  const selected = encodePlanner(props.value.harness, props.value.model);

  // Is the current selection present in the loaded inventory? When the registry
  // hasn't loaded yet (empty), or the persisted model is unknown, we still show
  // the current value as an option so the selection is never silently dropped.
  const known = harnesses.some(
    (h) => h.name === props.value.harness && h.models.some((m) => m.id === props.value.model),
  );

  return (
    <label style={S.field}>
      <span style={S.label}>{props.label}</span>
      <select
        style={S.select}
        value={selected}
        onChange={(e) => props.onChange(decodePlanner(e.target.value))}
      >
        {!known && (
          <option value={selected}>
            {props.value.model} ({props.value.harness})
          </option>
        )}
        {harnesses.map((h) => (
          <optgroup key={h.name} label={harnessLabel(h)}>
            {h.models.map((m) => (
              <option key={`${h.name} ${m.id}`} value={encodePlanner(h.name, m.id)}>
                {m.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

/** Human label for a harness optgroup: its provider, falling back to its name. */
function harnessLabel(h: HarnessInfo): string {
  const provider = String(h.account?.provider ?? h.name).trim();
  const base = provider || h.name;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function RunOverview(props: { data: DialecticData }): ReactElement {
  const { data } = props;
  const stages: Array<{ speaker: DialecticSpeaker; label: string }> = [
    { speaker: "A", label: speakerName(data.config.mode, "A") },
    { speaker: "B", label: speakerName(data.config.mode, "B") },
    { speaker: "synthesis", label: "Synthesis" },
  ];

  return (
    <section style={S.overview} aria-label="Dialectic context flow">
      <div style={S.overviewTop}>
        <div>
          <div style={S.eyebrow}>Context flow</div>
          <div style={S.topicPreview}>{data.topic || "Untitled dialectic"}</div>
        </div>
        <div style={S.roundCount}>
          {data.config.rounds} {data.config.rounds === 1 ? "round" : "rounds"}
        </div>
      </div>
      <div style={S.flow}>
        {stages.map((stage, index) => {
          const isActive = data.activeSpeaker === stage.speaker;
          const isDone =
            stage.speaker === "synthesis"
              ? Boolean(data.synthesis)
              : data.turns.some((turn) => turn.speaker === stage.speaker && Boolean(turn.text));
          const planner =
            stage.speaker === "A"
              ? data.config.plannerA
              : stage.speaker === "B"
                ? data.config.plannerB
                : data.config.synthesis ?? data.config.plannerA;
          return (
            <div key={stage.speaker} style={S.flowGroup}>
              {index > 0 && <span style={S.flowArrow}>→</span>}
              <div style={isActive ? S.flowStageActive : S.flowStage}>
                <span style={isDone ? S.stageDotDone : isActive ? S.stageDotActive : S.stageDot}>
                  {isDone && <Check size={9} aria-hidden="true" />}
                </span>
                <span style={S.stageText}>
                  <span style={S.stageLabel}>{stage.label}</span>
                  <span style={S.stageModel}>{planner.model}</span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ExchangeTimeline(props: {
  turns: DialecticTurnRecord[];
  config: DialecticConfig;
  activeSpeaker: DialecticSpeaker | null;
  activeRound: number | null;
}): ReactElement {
  const latestTurnRound = props.turns.reduce((latest, turn) => Math.max(latest, turn.round), 0);
  const roundCount = Math.max(props.config.rounds, latestTurnRound + 1);
  const [selectedRound, setSelectedRound] = useState(
    props.activeRound ?? latestTurnRound,
  );

  useEffect(() => {
    if (props.activeRound !== null) setSelectedRound(props.activeRound);
  }, [props.activeRound]);

  useEffect(() => {
    setSelectedRound((current) => Math.min(current, roundCount - 1));
  }, [roundCount]);

  const turnA = props.turns.find(
    (turn) => turn.speaker === "A" && turn.round === selectedRound,
  );
  const turnB = props.turns.find(
    (turn) => turn.speaker === "B" && turn.round === selectedRound,
  );
  const roleA = speakerName(props.config.mode, "A");
  const roleB = speakerName(props.config.mode, "B");
  const hasAnyTurn = props.turns.length > 0;

  return (
    <section style={S.timeline} aria-label="Model exchange">
      <div style={S.timelineHeading}>
        <span style={S.timelineTitle}>
          <MessageSquareText size={13} aria-hidden="true" />
          <span>Round-by-round exchange</span>
        </span>
        <span style={S.timelineHint}>Choose a round to inspect what each model saw.</span>
      </div>

      <div style={S.roundNavigator}>
        <button
          type="button"
          style={S.roundArrow}
          onClick={() => setSelectedRound((round) => Math.max(0, round - 1))}
          disabled={selectedRound === 0}
          aria-label="Previous round"
        >
          <ChevronLeft size={14} />
        </button>
        <div style={S.roundTabs} role="tablist" aria-label="Dialectic rounds">
          {Array.from({ length: roundCount }, (_, round) => {
            const turns = props.turns.filter((turn) => turn.round === round);
            const isComplete = turns.filter((turn) => Boolean(turn.text)).length === 2;
            const isActive = props.activeRound === round;
            const isSelected = selectedRound === round;
            return (
              <button
                key={round}
                type="button"
                role="tab"
                aria-selected={isSelected}
                aria-controls="dialectic-round-panel"
                style={
                  isSelected
                    ? S.roundTabSelected
                    : isActive
                      ? S.roundTabActive
                      : S.roundTab
                }
                onClick={() => setSelectedRound(round)}
              >
                <span
                  style={
                    isComplete
                      ? S.roundTabDotComplete
                      : isActive
                        ? S.roundTabDotActive
                        : S.roundTabDot
                  }
                >
                  {isComplete && <Check size={8} aria-hidden="true" />}
                </span>
                <span>R{round + 1}</span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          style={S.roundArrow}
          onClick={() => setSelectedRound((round) => Math.min(roundCount - 1, round + 1))}
          disabled={selectedRound === roundCount - 1}
          aria-label="Next round"
        >
          <ChevronRight size={14} />
        </button>
      </div>

      <div
        id="dialectic-round-panel"
        role="tabpanel"
        style={S.round}
        data-no-drag
        aria-label={`Round ${selectedRound + 1} of ${roundCount}`}
      >
        <div style={S.roundHeader}>
          <span>Round {selectedRound + 1} of {roundCount}</span>
          <span style={S.roundRule} />
          <span style={S.roundStatus}>
            {turnA?.text && turnB?.text
              ? "Complete"
              : props.activeRound === selectedRound
                ? "In progress"
                : turnA || turnB
                  ? "Partial"
                  : "Not started"}
          </span>
        </div>

        {!turnA && !turnB && (
          <div style={S.placeholder}>
            {hasAnyTurn
              ? "This round has not started yet. Choose an earlier round to inspect the exchange."
              : "The first model exchange will appear here."}
          </div>
        )}

        {turnA && (
          <TurnCard
            turn={turnA}
            role={roleA}
            planner={props.config.plannerA}
            isActive={props.activeSpeaker === "A" && props.activeRound === selectedRound}
            sourceLabel={
              selectedRound === 0 ? "Task brief" : `${roleB} · round ${selectedRound}`
            }
            priorSelfTurns={selectedRound}
          />
        )}
        {(turnA || turnB) && (
          <div style={S.transfer}>
            <ArrowDown size={12} aria-hidden="true" />
            <span>
              {turnA?.text
                ? `${roleA} output becomes new input for ${roleB}`
                : `Waiting to send ${roleA} output to ${roleB}`}
            </span>
          </div>
        )}
        {turnB && (
          <TurnCard
            turn={turnB}
            role={roleB}
            planner={props.config.plannerB}
            isActive={props.activeSpeaker === "B" && props.activeRound === selectedRound}
            sourceLabel={`${roleA} · round ${selectedRound + 1}`}
            priorSelfTurns={selectedRound}
            emphasizeContext
          />
        )}
      </div>
    </section>
  );
}

function TurnCard(props: {
  turn: DialecticTurnRecord;
  role: string;
  planner: PlannerConfig;
  isActive: boolean;
  sourceLabel: string;
  priorSelfTurns: number;
  emphasizeContext?: boolean;
}): ReactElement {
  const { turn } = props;
  const hasResponse = Boolean(turn.text);
  const contextSummary = turn.context
    ? turn.context.retainedThread
      ? `Continuing session · ${props.priorSelfTurns} earlier ${props.role} ${
          props.priorSelfTurns === 1 ? "turn" : "turns"
        } retained`
      : "New session · role instructions establish the model's perspective"
    : "Context details unavailable for this earlier turn";

  return (
    <article
      style={
        turn.isError
          ? S.turnError
          : props.isActive
            ? S.turnActive
            : props.emphasizeContext
              ? S.turnCritic
              : S.turn
      }
    >
      <div style={S.turnHeader}>
        <div style={S.turnIdentity}>
          <span style={props.emphasizeContext ? S.avatarCritic : S.avatar}>
            {props.role.slice(0, 1)}
          </span>
          <span>
            <span style={S.turnRole}>{props.role}</span>
            <span style={S.turnModel}>
              {props.planner.model} · {props.planner.harness}
            </span>
          </span>
        </div>
        <span style={props.isActive ? S.turnStateActive : S.turnState}>
          {turn.isError ? "Failed" : props.isActive ? "Working" : hasResponse ? "Shared" : "Queued"}
        </span>
      </div>

      <div style={S.contextMap}>
        <div style={S.contextMapIcon} aria-hidden="true">
          <History size={13} />
        </div>
        <div style={S.contextMapBody}>
          <span style={S.contextMapTitle}>{contextSummary}</span>
          <span style={S.contextRoute}>
            <span style={S.contextSource}>{props.sourceLabel}</span>
            <span aria-hidden="true">→</span>
            <span style={S.contextTarget}>new input to {props.role}</span>
          </span>
        </div>
      </div>

      <div style={S.outputLabel}>Shared model output</div>
      <div style={hasResponse ? S.turnText : S.pendingText}>
        {turn.text || (turn.isError ? "(turn failed)" : "Preparing a response that can be shared…")}
      </div>

      <details style={S.contextDetails}>
        <summary style={S.contextSummary}>
          <span>
            Inspect exact input to {props.role}
          </span>
          <span style={S.contextScope}>
            {turn.context?.retainedThread
              ? "Only the new message is shown; earlier session history remains retained."
              : "This is the complete starting context for the new session."}
          </span>
        </summary>
        <div style={S.contextBody}>
          {turn.context ? (
            <>
              {turn.context.systemPrompt && (
                <div style={S.contextSection}>
                  <div style={S.contextLabel}>Role instructions</div>
                  <pre style={S.contextText}>{turn.context.systemPrompt}</pre>
                </div>
              )}
              <div style={S.contextSection}>
                <div style={S.contextLabel}>
                  {turn.context.retainedThread ? "New message appended" : "User message"}
                </div>
                <pre style={S.contextText}>{turn.context.prompt}</pre>
              </div>
            </>
          ) : (
            <div style={S.contextUnavailable}>
              This turn predates context capture. Its shared response is still available above.
            </div>
          )}
        </div>
      </details>
    </article>
  );
}

function StatusBadge(props: { status: DialecticRunStatus }): ReactElement {
  const color: Record<DialecticRunStatus, string> = {
    idle: "var(--text-muted)",
    running: "var(--status-running)",
    completed: "var(--status-success)",
    stopped: "var(--status-stopped)",
    error: "var(--status-error)",
  };
  return (
    <span style={S.badge}>
      <span style={{ ...S.badgeDot, background: color[props.status] }} />
      {props.status}
    </span>
  );
}

function speakerName(mode: DialecticMode, speaker: DialecticSpeaker): string {
  if (speaker === "synthesis") return "Synthesis";
  if (mode === "proposer-critic") return speaker === "A" ? "Proposer" : "Critic";
  if (mode === "debate-synthesis") return speaker === "A" ? "Advocate" : "Challenger";
  return speaker === "A" ? "Planner A" : "Planner B";
}

// ── Styles (inline; experimental node keeps its footprint self-contained) ────

const LABEL: CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "var(--text-muted)",
  fontFamily: "var(--font-mono)",
};

const CONTROL: CSSProperties = {
  padding: "5px 7px",
  borderRadius: "var(--radius-control)",
  border: "1px solid var(--border-default)",
  background: "var(--bg-elevated)",
  color: "var(--text-primary)",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  outline: "none",
};

const S = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: 12,
    height: "100%",
    minHeight: 0,
    overflow: "auto",
    overscrollBehavior: "contain",
    scrollbarGutter: "stable",
    fontSize: 12,
    background: "var(--bg-surface)",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-node)",
    color: "var(--text-primary)",
    fontFamily: "var(--font-sans)",
    boxSizing: "border-box",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    position: "sticky",
    top: -12,
    zIndex: 2,
    margin: "-12px -12px 0",
    padding: "12px 12px 8px",
    borderBottom: "1px solid var(--border-default)",
    background: "var(--bg-surface)",
    flexShrink: 0,
  },
  titleGroup: { display: "flex", alignItems: "center", gap: 8 },
  titleIcon: {
    display: "grid",
    placeItems: "center",
    width: 26,
    height: 26,
    borderRadius: "var(--radius-control)",
    color: "var(--accent)",
    background: "color-mix(in srgb, var(--accent) 11%, transparent)",
    border: "1px solid color-mix(in srgb, var(--accent) 24%, transparent)",
  },
  title: { display: "block", fontWeight: 650, fontSize: 13, color: "var(--text-primary)" },
  subtitle: { display: "block", marginTop: 1, fontSize: 9, color: "var(--text-muted)" },
  configDisclosure: {
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-panel)",
    background: "var(--bg-primary)",
    flexShrink: 0,
  },
  configSummary: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    padding: "8px 10px",
    color: "var(--text-secondary)",
    cursor: "pointer",
    fontSize: 10,
    fontWeight: 650,
  },
  configSummaryMeta: {
    color: "var(--text-muted)",
    fontFamily: "var(--font-mono)",
    fontSize: 8,
    fontWeight: 400,
    textAlign: "right",
  },
  config: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: 10,
    borderTop: "1px solid var(--border-default)",
    flexShrink: 0,
  },
  field: { display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 0 },
  label: LABEL,
  textarea: {
    ...CONTROL,
    background: "var(--bg-primary)",
    resize: "vertical",
    minHeight: 44,
    lineHeight: 1.4,
  },
  select: CONTROL,
  row: { display: "flex", gap: 8 },
  hint: { fontSize: 11, color: "var(--text-muted)", lineHeight: 1.35 },
  actions: { display: "flex", alignItems: "center", gap: 10, flexShrink: 0 },
  startBtn: {
    padding: "6px 14px",
    borderRadius: "var(--radius-control)",
    border: "none",
    background: "var(--accent)",
    color: "#111",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 11,
    fontFamily: "var(--font-sans)",
  },
  stopBtn: {
    padding: "6px 14px",
    borderRadius: "var(--radius-control)",
    border: "1px solid var(--danger-color)",
    background: "var(--danger-bg)",
    color: "var(--status-error)",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 11,
    fontFamily: "var(--font-mono)",
  },
  active: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    fontSize: 10,
    color: "var(--status-running)",
    fontFamily: "var(--font-mono)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  pulseDot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "var(--status-running)",
    boxShadow: "0 0 0 3px color-mix(in srgb, var(--status-running) 16%, transparent)",
    flexShrink: 0,
  },
  error: {
    padding: "6px 10px",
    borderRadius: "var(--radius-control)",
    background: "var(--danger-bg)",
    border: "1px solid var(--danger-color)",
    color: "var(--status-error)",
    fontSize: 11,
    fontFamily: "var(--font-mono)",
    flexShrink: 0,
  },
  overview: {
    display: "flex",
    flexDirection: "column",
    gap: 9,
    padding: 10,
    borderRadius: "var(--radius-panel)",
    border: "1px solid var(--border-default)",
    background: "var(--bg-primary)",
    flexShrink: 0,
  },
  overviewTop: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
  eyebrow: LABEL,
  topicPreview: {
    marginTop: 3,
    color: "var(--text-primary)",
    fontSize: 11,
    fontWeight: 550,
    lineHeight: 1.35,
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },
  roundCount: {
    flexShrink: 0,
    padding: "2px 6px",
    borderRadius: "var(--radius-pill)",
    background: "var(--bg-elevated)",
    color: "var(--text-muted)",
    fontSize: 9,
    fontFamily: "var(--font-mono)",
  },
  flow: { display: "flex", alignItems: "center", minWidth: 0 },
  flowGroup: { display: "flex", alignItems: "center", flex: 1, minWidth: 0 },
  flowArrow: { color: "var(--text-dim)", padding: "0 5px", fontSize: 11, flexShrink: 0 },
  flowStage: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
    flex: 1,
    padding: "5px 6px",
    borderRadius: "var(--radius-control)",
    border: "1px solid transparent",
  },
  flowStageActive: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
    flex: 1,
    padding: "5px 6px",
    borderRadius: "var(--radius-control)",
    border: "1px solid color-mix(in srgb, var(--status-running) 35%, transparent)",
    background: "color-mix(in srgb, var(--status-running) 8%, transparent)",
  },
  stageDot: {
    width: 13,
    height: 13,
    display: "grid",
    placeItems: "center",
    borderRadius: "50%",
    border: "1px solid var(--border-hover)",
    color: "var(--bg-primary)",
    flexShrink: 0,
  },
  stageDotActive: {
    width: 13,
    height: 13,
    display: "grid",
    placeItems: "center",
    borderRadius: "50%",
    border: "1px solid var(--status-running)",
    background: "var(--status-running)",
    color: "var(--bg-primary)",
    flexShrink: 0,
  },
  stageDotDone: {
    width: 13,
    height: 13,
    display: "grid",
    placeItems: "center",
    borderRadius: "50%",
    border: "1px solid var(--status-success)",
    background: "var(--status-success)",
    color: "var(--bg-primary)",
    flexShrink: 0,
  },
  stageText: { display: "flex", flexDirection: "column", minWidth: 0 },
  stageLabel: { color: "var(--text-secondary)", fontSize: 9, fontWeight: 600 },
  stageModel: {
    color: "var(--text-muted)",
    fontSize: 8,
    fontFamily: "var(--font-mono)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  disclosureNote: {
    display: "flex",
    alignItems: "flex-start",
    gap: 7,
    padding: "7px 9px",
    borderRadius: "var(--radius-control)",
    color: "var(--text-secondary)",
    background: "var(--info-bg)",
    border: "1px solid color-mix(in srgb, var(--info-color) 20%, transparent)",
    fontSize: 10,
    lineHeight: 1.4,
    flexShrink: 0,
  },
  timeline: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    minHeight: 0,
    padding: 10,
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-panel)",
    background: "var(--bg-primary)",
    flexShrink: 0,
  },
  timelineHeading: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 12,
  },
  timelineTitle: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    ...LABEL,
    color: "var(--text-secondary)",
    fontSize: 10,
  },
  timelineHint: {
    color: "var(--text-muted)",
    fontSize: 9,
    lineHeight: 1.3,
    textAlign: "right",
  },
  roundNavigator: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    padding: 4,
    borderRadius: "var(--radius-control)",
    background: "var(--bg-secondary)",
    border: "1px solid var(--border-default)",
  },
  roundTabs: {
    display: "flex",
    alignItems: "center",
    gap: 3,
    minWidth: 0,
    flex: 1,
    overflowX: "auto",
    scrollbarWidth: "none",
  },
  roundArrow: {
    display: "grid",
    placeItems: "center",
    width: 24,
    height: 24,
    flexShrink: 0,
    border: "none",
    borderRadius: 5,
    color: "var(--text-secondary)",
    background: "transparent",
    cursor: "pointer",
  },
  roundTab: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    minWidth: 46,
    height: 26,
    padding: "0 7px",
    border: "1px solid transparent",
    borderRadius: 5,
    background: "transparent",
    color: "var(--text-muted)",
    cursor: "pointer",
    fontFamily: "var(--font-mono)",
    fontSize: 9,
  },
  roundTabActive: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    minWidth: 46,
    height: 26,
    padding: "0 7px",
    border: "1px solid color-mix(in srgb, var(--status-running) 30%, transparent)",
    borderRadius: 5,
    background: "color-mix(in srgb, var(--status-running) 7%, transparent)",
    color: "var(--status-running)",
    cursor: "pointer",
    fontFamily: "var(--font-mono)",
    fontSize: 9,
  },
  roundTabSelected: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    minWidth: 46,
    height: 26,
    padding: "0 7px",
    border: "1px solid color-mix(in srgb, var(--accent) 35%, transparent)",
    borderRadius: 5,
    background: "color-mix(in srgb, var(--accent) 11%, var(--bg-elevated))",
    color: "var(--text-primary)",
    cursor: "pointer",
    fontFamily: "var(--font-mono)",
    fontSize: 9,
    fontWeight: 650,
  },
  roundTabDot: {
    width: 9,
    height: 9,
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    borderRadius: "50%",
    border: "1px solid var(--border-hover)",
  },
  roundTabDotActive: {
    width: 9,
    height: 9,
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    borderRadius: "50%",
    border: "1px solid var(--status-running)",
    background: "var(--status-running)",
  },
  roundTabDotComplete: {
    width: 9,
    height: 9,
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    borderRadius: "50%",
    border: "1px solid var(--status-success)",
    background: "var(--status-success)",
    color: "var(--bg-primary)",
  },
  round: { display: "flex", flexDirection: "column", gap: 6 },
  roundHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    color: "var(--text-muted)",
    fontFamily: "var(--font-mono)",
    fontSize: 9,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  roundRule: { height: 1, background: "var(--border-default)", flex: 1 },
  roundStatus: {
    color: "var(--text-muted)",
    fontSize: 8,
    letterSpacing: 0,
    textTransform: "none",
  },
  placeholder: { fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" },
  turn: {
    padding: 10,
    borderRadius: "var(--radius-panel)",
    background: "var(--bg-secondary)",
    border: "1px solid var(--border-default)",
    color: "var(--text-primary)",
  },
  turnCritic: {
    padding: 10,
    borderRadius: "var(--radius-panel)",
    background: "color-mix(in srgb, var(--accent) 4%, var(--bg-secondary))",
    border: "1px solid color-mix(in srgb, var(--accent) 26%, var(--border-default))",
    color: "var(--text-primary)",
  },
  turnActive: {
    padding: 10,
    borderRadius: "var(--radius-panel)",
    background: "color-mix(in srgb, var(--status-running) 5%, var(--bg-secondary))",
    border: "1px solid color-mix(in srgb, var(--status-running) 38%, var(--border-default))",
    color: "var(--text-primary)",
  },
  turnError: {
    padding: 10,
    borderRadius: "var(--radius-panel)",
    background: "var(--danger-bg)",
    border: "1px solid var(--danger-color)",
    color: "var(--text-primary)",
  },
  turnHeader: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 },
  turnIdentity: { display: "flex", alignItems: "center", gap: 7, minWidth: 0 },
  avatar: {
    display: "grid",
    placeItems: "center",
    width: 22,
    height: 22,
    borderRadius: 6,
    color: "var(--info-color)",
    background: "var(--info-bg)",
    border: "1px solid color-mix(in srgb, var(--info-color) 28%, transparent)",
    fontSize: 10,
    fontWeight: 700,
    flexShrink: 0,
  },
  avatarCritic: {
    display: "grid",
    placeItems: "center",
    width: 22,
    height: 22,
    borderRadius: 6,
    color: "var(--accent)",
    background: "color-mix(in srgb, var(--accent) 10%, transparent)",
    border: "1px solid color-mix(in srgb, var(--accent) 28%, transparent)",
    fontSize: 10,
    fontWeight: 700,
    flexShrink: 0,
  },
  turnRole: { display: "block", color: "var(--text-primary)", fontSize: 11, fontWeight: 650 },
  turnModel: {
    display: "block",
    marginTop: 1,
    color: "var(--text-muted)",
    fontSize: 8,
    fontFamily: "var(--font-mono)",
  },
  turnState: {
    padding: "2px 5px",
    borderRadius: "var(--radius-pill)",
    background: "var(--bg-elevated)",
    color: "var(--text-muted)",
    fontSize: 8,
    fontFamily: "var(--font-mono)",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  turnStateActive: {
    padding: "2px 5px",
    borderRadius: "var(--radius-pill)",
    background: "color-mix(in srgb, var(--status-running) 14%, transparent)",
    color: "var(--status-running)",
    fontSize: 8,
    fontFamily: "var(--font-mono)",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  outputLabel: { ...LABEL, marginTop: 10, marginBottom: 4, fontSize: 8 },
  turnText: {
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    lineHeight: 1.45,
    color: "var(--text-primary)",
    fontSize: 11,
  },
  pendingText: {
    color: "var(--text-muted)",
    fontSize: 10,
    fontStyle: "italic",
    lineHeight: 1.4,
  },
  contextMap: {
    display: "flex",
    alignItems: "flex-start",
    gap: 7,
    marginTop: 9,
    padding: "7px 8px",
    borderRadius: "var(--radius-control)",
    background: "var(--bg-primary)",
    border: "1px solid var(--border-default)",
  },
  contextMapIcon: {
    display: "grid",
    placeItems: "center",
    width: 22,
    height: 22,
    flexShrink: 0,
    borderRadius: 5,
    color: "var(--info-color)",
    background: "var(--info-bg)",
  },
  contextMapBody: { display: "flex", flexDirection: "column", gap: 5, minWidth: 0 },
  contextMapTitle: {
    color: "var(--text-secondary)",
    fontSize: 9,
    lineHeight: 1.35,
  },
  contextRoute: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    minWidth: 0,
    color: "var(--text-dim)",
    fontFamily: "var(--font-mono)",
    fontSize: 8,
  },
  contextSource: {
    padding: "2px 5px",
    borderRadius: "var(--radius-pill)",
    color: "var(--accent)",
    background: "color-mix(in srgb, var(--accent) 9%, transparent)",
    whiteSpace: "nowrap",
  },
  contextTarget: {
    color: "var(--text-muted)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  transfer: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginLeft: 20,
    paddingLeft: 7,
    color: "var(--text-muted)",
    borderLeft: "1px dashed var(--border-hover)",
    fontSize: 9,
    lineHeight: 1.3,
  },
  contextDetails: {
    marginTop: 9,
    borderRadius: "var(--radius-control)",
    background: "var(--bg-primary)",
    border: "1px solid var(--border-default)",
    overflow: "hidden",
  },
  contextSummary: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    padding: "7px 8px",
    color: "var(--text-secondary)",
    cursor: "pointer",
    fontSize: 9,
    fontWeight: 600,
    listStylePosition: "inside",
  },
  contextScope: { color: "var(--text-muted)", fontSize: 8, fontWeight: 400, fontFamily: "var(--font-mono)" },
  contextBody: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: 8,
    borderTop: "1px solid var(--border-default)",
  },
  contextSection: { display: "flex", flexDirection: "column", gap: 4 },
  contextLabel: { ...LABEL, fontSize: 8 },
  contextText: {
    margin: 0,
    padding: 7,
    maxHeight: 180,
    overflow: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    borderRadius: 5,
    background: "var(--bg-secondary)",
    color: "var(--text-secondary)",
    fontFamily: "var(--font-mono)",
    fontSize: 9,
    lineHeight: 1.45,
  },
  contextUnavailable: { color: "var(--text-muted)", fontSize: 9, lineHeight: 1.4 },
  synthesis: {
    border: "1px solid var(--status-success)",
    borderRadius: "var(--radius-panel)",
    background: "var(--success-bg)",
    padding: 10,
    flexShrink: 0,
  },
  synthesisTitle: {
    ...LABEL,
    color: "var(--status-success)",
    marginBottom: 5,
    fontSize: 11,
  },
  synthesisBody: { whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.45, color: "var(--text-primary)" },
  badge: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    color: "var(--text-secondary)",
    borderRadius: "var(--radius-pill)",
    padding: "2px 7px",
    border: "1px solid var(--border-default)",
    background: "var(--bg-primary)",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    fontFamily: "var(--font-mono)",
    fontWeight: 600,
  },
  badgeDot: { width: 6, height: 6, borderRadius: "50%" },
} satisfies Record<string, CSSProperties>;

// ── Registration ─────────────────────────────────────────────────────────────

registerNodeType({
  type: "dialectic",
  label: "Dialectic",
  defaultSize: { width: 620, height: 560 },
  render: DialecticNodeRenderer,
  userCreatable: true,
  flag: FLAG_DIALECTIC,
  providesContext: true,
  // Expose the synthesized plan (falling back to the raw transcript) as context.
  extractContent: (raw) => {
    const d = raw as Partial<DialecticData> | undefined;
    if (d?.synthesis) return d.synthesis;
    if (Array.isArray(d?.turns) && d.turns.length > 0) {
      return d.turns.map((t) => `[${t.speaker} · round ${t.round + 1}]\n${t.text}`).join("\n\n");
    }
    return null;
  },
});

export { DialecticNodeRenderer };
