import type { WorkItemRunSnapshot } from "../shared/work-item-contracts.ts";
import type { DisplayMessage } from "./sdk-messages.ts";
import type { SessionStreamState } from "./session-stream.ts";
import { SessionTranscript, type TranscriptBoundary, type TranscriptEntry } from "./components/SessionTranscript.tsx";
import type { WorkItemHistoryState } from "./use-work-item-history.ts";

interface RunTaskContext {
  graphNodes?: readonly { id: string; title: string }[] | undefined;
  taskPlan?: readonly { taskId: string; title: string }[] | undefined;
  onInspectNode?: ((nodeId: string) => void) | undefined;
}

function runBoundary(run: WorkItemRunSnapshot, context: RunTaskContext): TranscriptBoundary {
  const onInspectNode = context.onInspectNode;
  const node = run.runKind === "child"
    ? context.graphNodes?.find((node) => node.id === run.taskId) : undefined;
  const title = node?.title ?? context.taskPlan?.find((task) => task.taskId === run.taskId)?.title;
  const label = run.runKind === "primary"
    ? `Iteration ${run.runNumber ?? "?"}`
    : `Child run${title ? ` · ${title}` : ""}`;
  const state = run.outcome === "none" ? "Active now" : run.outcome;
  return {
    id: `work-history-boundary-${run.runKey}`,
    kind: "run-boundary",
    label,
    content: `${label} · ${state}`,
    ...(node && onInspectNode ? { onInspect: () => onInspectNode(node.id) } : {}),
  };
}

export function buildUnifiedWorkItemMessages(input: {
  runs: readonly WorkItemRunSnapshot[];
  streams: Readonly<Record<string, SessionStreamState>>;
  currentRunKey: string;
  currentMessages: readonly DisplayMessage[];
} & RunTaskContext): TranscriptEntry[] {
  const { runs, streams, currentRunKey, currentMessages } = input;
  if (runs.length === 0) return [...currentMessages];
  const unified: TranscriptEntry[] = [];
  for (const run of runs) {
    unified.push(runBoundary(run, input));
    const replay = streams[run.runKey]?.messages ?? [];
    const messages = run.runKey === currentRunKey && currentMessages.length > 0
      ? currentMessages
      : replay;
    unified.push(...messages);
  }
  // Session updates and ledger pages arrive independently. Preserve the
  // current conversation while its run is still missing from cached history.
  if (!runs.some((run) => run.runKey === currentRunKey)) {
    unified.push(...currentMessages);
  }
  return unified;
}

export function WorkItemTranscript(props: {
  runs: readonly WorkItemRunSnapshot[];
  streams: Readonly<Record<string, SessionStreamState>>;
  currentRunKey: string;
  currentMessages: readonly DisplayMessage[];
  currentStreamingText: string;
  loading: boolean;
  thinking?: boolean | undefined;
} & RunTaskContext) {
  const messages = buildUnifiedWorkItemMessages(props);
  return (
    <div className="act-work-history-transcript" aria-busy={props.loading}>
      {props.loading && (
        <div className="act-work-history-loading" role="status">
          Loading connected run history…
        </div>
      )}
      <SessionTranscript messages={messages} streamingText={props.currentStreamingText}
        thinking={props.thinking} />
    </div>
  );
}

export function ActivityTranscript(props: {
  unified: boolean;
  history: WorkItemHistoryState;
  currentRunKey: string;
  currentMessages: readonly DisplayMessage[];
  currentStreamingText: string;
  thinking?: boolean | undefined;
} & RunTaskContext) {
  if (!props.unified) {
    return <SessionTranscript messages={[...props.currentMessages]}
      streamingText={props.currentStreamingText} thinking={props.thinking} />;
  }
  return <WorkItemTranscript runs={props.history.orderedRuns} streams={props.history.streams}
    currentRunKey={props.currentRunKey} currentMessages={props.currentMessages}
    currentStreamingText={props.currentStreamingText} loading={props.history.loading}
    graphNodes={props.graphNodes} taskPlan={props.taskPlan} onInspectNode={props.onInspectNode}
    thinking={props.thinking} />;
}
