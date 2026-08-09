import type { WorkItemRunSnapshot } from "../shared/work-item-contracts.ts";
import type { DisplayMessage } from "./sdk-messages.ts";
import type { SessionStreamState } from "./session-stream.ts";
import { SessionTranscript } from "./components/SessionTranscript.tsx";
import type { WorkItemHistoryState } from "./use-work-item-history.ts";

function runBoundary(run: WorkItemRunSnapshot): DisplayMessage {
  const label = run.runKind === "primary"
    ? `Iteration ${run.runNumber ?? "?"}`
    : `Child run${run.taskId ? ` · ${run.taskId}` : ""}`;
  const state = run.outcome === "none" ? "Active now" : run.outcome;
  return {
    id: `work-history-boundary-${run.runKey}`,
    role: "system",
    content: `${label} · ${state}`,
    timestamp: run.startedAt,
  };
}

export function buildUnifiedWorkItemMessages(input: {
  runs: readonly WorkItemRunSnapshot[];
  streams: Readonly<Record<string, SessionStreamState>>;
  currentRunKey: string;
  currentMessages: readonly DisplayMessage[];
}): DisplayMessage[] {
  const { runs, streams, currentRunKey, currentMessages } = input;
  if (runs.length === 0) return [...currentMessages];
  const unified: DisplayMessage[] = [];
  for (const run of runs) {
    unified.push(runBoundary(run));
    const replay = streams[run.runKey]?.messages ?? [];
    const messages = run.runKey === currentRunKey && currentMessages.length > 0
      ? currentMessages
      : replay;
    unified.push(...messages);
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
}) {
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
}) {
  if (!props.unified) {
    return <SessionTranscript messages={[...props.currentMessages]}
      streamingText={props.currentStreamingText} thinking={props.thinking} />;
  }
  return <WorkItemTranscript runs={props.history.orderedRuns} streams={props.history.streams}
    currentRunKey={props.currentRunKey} currentMessages={props.currentMessages}
    currentStreamingText={props.currentStreamingText} loading={props.history.loading}
    thinking={props.thinking} />;
}
