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

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { CSSProperties, ReactElement } from "react";
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
function reduce(data: DialecticData, event: DialecticEvent): DialecticData {
  switch (event.kind) {
    case "run_status":
      return {
        ...data,
        status: event.status,
        error: event.status === "error" ? event.error ?? "Dialectic failed" : null,
        activeSpeaker: event.status === "running" ? data.activeSpeaker : null,
      };
    case "turn_started":
      return { ...data, activeSpeaker: event.speaker, activeRound: event.round };
    case "turn_completed": {
      // Idempotent: replace a matching (speaker, round) turn if it already exists.
      const same = (t: DialecticTurnRecord) => t.speaker === event.speaker && t.round === event.round;
      const rest = data.turns.filter((t) => !same(t));
      const record: DialecticTurnRecord = { speaker: event.speaker, round: event.round, text: event.text };
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
  const { node, onUpdateData, socketSend, socketSubscribe, projectPath } = props;
  const data = useMemo(() => normalizeData(node.data), [node.data]);
  const dataRef = useRef(data);
  dataRef.current = data;

  const keys = useMemo(() => dialecticSessionKeys(node.id), [node.id]);
  const running = data.status === "running";

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
      cwd: projectPath,
      prompt: topic,
      dialecticConfig: dataRef.current.config,
    });
  }, [socketSend, onUpdateData, node.id, projectPath]);

  const stop = useCallback(() => {
    socketSend?.({ type: "stop_dialectic", sessionKey: node.id });
    patch({ status: "stopped", activeSpeaker: null });
  }, [socketSend, node.id, patch]);

  const turnsA = data.turns.filter((t) => t.speaker === "A").sort((a, b) => a.round - b.round);
  const turnsB = data.turns.filter((t) => t.speaker === "B").sort((a, b) => a.round - b.round);

  return (
    <div style={S.root} data-testid="dialectic-node">
      <header style={S.header}>
        <span style={S.title}>⚖️ Dialectic</span>
        <StatusBadge status={data.status} />
      </header>

      {!running && (
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
          <span style={S.active}>
            {speakerName(data.config.mode, data.activeSpeaker)} thinking… (round{" "}
            {(data.activeRound ?? 0) + 1})
          </span>
        )}
      </div>

      {data.error && <div style={S.error}>{data.error}</div>}

      {(data.turns.length > 0 || running) && (
        <div style={S.columns}>
          <TranscriptColumn title={speakerName(data.config.mode, "A")} turns={turnsA} />
          <TranscriptColumn title={speakerName(data.config.mode, "B")} turns={turnsB} />
        </div>
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

function TranscriptColumn(props: { title: string; turns: DialecticTurnRecord[] }): ReactElement {
  return (
    <div style={S.column}>
      <div style={S.columnTitle}>{props.title}</div>
      {props.turns.length === 0 && <div style={S.placeholder}>No turns yet.</div>}
      {props.turns.map((t) => (
        <div key={`${t.speaker}-${t.round}`} style={t.isError ? S.turnError : S.turn}>
          <div style={S.turnMeta}>Round {t.round + 1}</div>
          <div style={S.turnText}>{t.text || (t.isError ? "(turn failed)" : "")}</div>
        </div>
      ))}
    </div>
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
  return <span style={{ ...S.badge, background: color[props.status] }}>{props.status}</span>;
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
    overflow: "auto",
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
    paddingBottom: 8,
    borderBottom: "1px solid var(--border-default)",
    flexShrink: 0,
  },
  title: { fontWeight: 600, fontSize: 13, color: "var(--text-primary)" },
  config: { display: "flex", flexDirection: "column", gap: 8 },
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
  actions: { display: "flex", alignItems: "center", gap: 10 },
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
    fontSize: 10,
    color: "var(--status-running)",
    fontFamily: "var(--font-mono)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  error: {
    padding: "6px 10px",
    borderRadius: "var(--radius-control)",
    background: "var(--danger-bg)",
    border: "1px solid var(--danger-color)",
    color: "var(--status-error)",
    fontSize: 11,
    fontFamily: "var(--font-mono)",
  },
  columns: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  column: { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 },
  columnTitle: { ...LABEL, fontSize: 11, color: "var(--text-secondary)" },
  placeholder: { fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" },
  turn: {
    padding: 8,
    borderRadius: "var(--radius-control)",
    background: "var(--bg-secondary)",
    border: "1px solid var(--border-default)",
    color: "var(--text-primary)",
  },
  turnError: {
    padding: 8,
    borderRadius: "var(--radius-control)",
    background: "var(--danger-bg)",
    border: "1px solid var(--danger-color)",
    color: "var(--text-primary)",
  },
  turnMeta: { ...LABEL, marginBottom: 3 },
  turnText: { whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.4 },
  synthesis: {
    border: "1px solid var(--status-success)",
    borderRadius: "var(--radius-panel)",
    background: "var(--success-bg)",
    padding: 10,
  },
  synthesisTitle: {
    ...LABEL,
    color: "var(--status-success)",
    marginBottom: 5,
    fontSize: 11,
  },
  synthesisBody: { whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.45, color: "var(--text-primary)" },
  badge: {
    color: "var(--bg-primary)",
    borderRadius: "var(--radius-pill)",
    padding: "1px 8px",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    fontFamily: "var(--font-mono)",
    fontWeight: 600,
  },
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
