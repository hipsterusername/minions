/**
 * RoutineNode behavior tests.
 *
 * Pins down three contract points:
 *   1. On mount the node sends a `list_routines` WS command keyed to its
 *      own request id.
 *   2. The browse view renders routines returned via `routine_list` and
 *      lets the user trigger `start_routine` with the input draft.
 *   3. `routine_progress` snapshots matching the active runId update the
 *      running view (phases, steps, handoff).
 *
 * The node uses the same socket-subscribe mechanic every other node uses;
 * we mock the subscribe/send pair.
 */
import { act, render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  RoutineNodeRenderer,
  createRoutineNodeDefaultData,
  type RoutineNodeData,
} from "./RoutineNode.tsx";
import type { CanvasNode, NodeRenderProps } from "../types.ts";
import type {
  Routine,
  RoutineRunSnapshot,
} from "../../shared/routines/types.ts";

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

const TEST_ROUTINE: Routine = {
  id: "demo",
  name: "Demo routine",
  version: 1,
  inputs: [
    {
      name: "topic",
      label: "Topic",
      required: true,
    },
  ],
  phases: [
    {
      id: "p1",
      label: "Phase 1",
      steps: [{ id: "s1", label: "Step 1", routinePrompt: "do x", agent: "leader", skillIds: [], skillValues: {}, mcpServerIds: [], retries: 0 }],
    },
  ],
  failurePolicy: "fail-fast",
};

interface ProbeHandle {
  emit(msg: unknown): void;
  sent: unknown[];
  reveal: ReturnType<typeof vi.fn>;
}

interface ProbeProps {
  ref: { current: ProbeHandle | null };
  onSpawnLeaderChild?: NodeRenderProps["onSpawnLeaderChild"];
  initialData?: Partial<RoutineNodeData>;
}

function Probe({ ref, onSpawnLeaderChild, initialData }: ProbeProps) {
  const [data, setData] = useState<RoutineNodeData>({
    ...createRoutineNodeDefaultData(),
    ...initialData,
  });
  const subscribers = useState<((msg: unknown) => void)[]>([])[0];
  const sent: unknown[] = [];
  const reveal = vi.fn();

  ref.current = {
    emit: (msg) => {
      for (const s of subscribers) s(msg);
    },
    sent,
    reveal,
  };

  const node: CanvasNode = {
    id: "rn-test",
    type: "routine",
    position: { x: 0, y: 0 },
    size: { width: 480, height: 500 },
    data: data as unknown as Record<string, unknown>,
  };
  const props: NodeRenderProps = {
    node,
    isSelected: false,
    onUpdateData: (next) => setData(next as RoutineNodeData),
    socketSend: (raw: unknown) => sent.push(raw),
    socketSubscribe: (fn: (msg: unknown) => void) => {
      subscribers.push(fn);
      return () => {
        const idx = subscribers.indexOf(fn);
        if (idx >= 0) subscribers.splice(idx, 1);
      };
    },
    projectPath: "/tmp/proj",
    onRevealMinion: reveal,
    onSpawnLeaderChild,
  };

  return <RoutineNodeRenderer {...props} />;
}

describe("RoutineNode", () => {
  it("issues list_routines on mount", () => {
    const ref: { current: ProbeHandle | null } = { current: null };
    render(<Probe ref={ref} />);
    const sent = ref.current!.sent;
    const listCmd = sent.find(
      (c) => (c as { type?: string }).type === "list_routines",
    ) as { type: string; cwd: string; requestId: string } | undefined;
    expect(listCmd).toBeDefined();
    expect(listCmd!.cwd).toBe("/tmp/proj");
    expect(listCmd!.requestId).toMatch(/^routine-list-/);
  });

  it("renders the catalog after a routine_list reply and starts a run", () => {
    const ref: { current: ProbeHandle | null } = { current: null };
    render(<Probe ref={ref} />);
    const requestId = (
      ref.current!.sent.find(
        (c) => (c as { type?: string }).type === "list_routines",
      ) as { requestId: string }
    ).requestId;

    act(() => {
      ref.current!.emit({
        type: "routine_list",
        requestId,
        routines: [TEST_ROUTINE],
        invalid: [],
        runs: [],
      });
    });

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "demo" } });

    const topicInput = screen.getAllByRole("textbox")[0]!;
    fireEvent.change(topicInput, {
      target: { value: "ai safety" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    const startCmd = ref.current!.sent.find(
      (c) => (c as { type?: string }).type === "start_routine",
    ) as
      | {
          type: string;
          cwd: string;
          routineId: string;
          routineInputs: Record<string, string>;
        }
      | undefined;
    expect(startCmd).toBeDefined();
    expect(startCmd!.routineId).toBe("demo");
    expect(startCmd!.routineInputs["topic"]).toBe("ai safety");
  });

  // Removed `re-renders into running mode on routine_progress` (§5.5 TRIVIAL):
  // the only assertions were three `getBy*(...).toBeTruthy()` calls, each of
  // which already throws on absence — the matcher was redundant smoke.

  it("calls onSpawnLeaderChild when routine_step_leader_spawned matches the active runId", () => {
    const spawnFn = vi.fn();
    const ref: { current: ProbeHandle | null } = { current: null };
    // Mount with an active runId so the filter inside the handler passes
    render(
      <Probe
        ref={ref}
        onSpawnLeaderChild={spawnFn}
        initialData={{ phase: "running", runId: "run-abc" }}
      />,
    );

    act(() => {
      ref.current!.emit({
        type: "routine_step_leader_spawned",
        runId: "run-abc",
        phaseId: "p1",
        stepId: "s1",
        sessionKey: "leader-session-1",
      });
    });

    expect(spawnFn).toHaveBeenCalledOnce();
    expect(spawnFn).toHaveBeenCalledWith({
      runId: "run-abc",
      phaseId: "p1",
      stepId: "s1",
      sessionKey: "leader-session-1",
    });
  });

  it("renders a flat DAG step list when snapshot.mode === 'dag'", () => {
    const ref: { current: ProbeHandle | null } = { current: null };
    render(
      <Probe
        ref={ref}
        initialData={{ phase: "running", runId: "run-dag" }}
      />,
    );

    const dagSnapshot: RoutineRunSnapshot = {
      runId: "run-dag",
      routineId: "demo",
      routineName: "Demo routine",
      state: "running",
      inputs: {},
      mode: "dag",
      phases: [
        {
          phaseId: "main",
          label: "Main",
          state: "pending",
          steps: [
            { stepId: "a", label: "Step A" },
            { stepId: "b", label: "Step B" },
          ],
        },
      ],
      dagSteps: [
        {
          stepId: "a",
          label: "Step A",
          phaseId: "main",
          dependsOn: [],
          state: "success",
          outcome: "success",
          summary: "a summary",
        },
        {
          stepId: "b",
          label: "Step B",
          phaseId: "main",
          dependsOn: ["a"],
          state: "running",
        },
      ],
      startedAt: "2026-04-26T00:00:00.000Z",
    };

    act(() => {
      ref.current!.emit({
        type: "routine_progress",
        runId: "run-dag",
        snapshot: dagSnapshot,
      });
    });

    // Removed three `getByText(...).toBeTruthy()` smoke checks (§5.5 TRIVIAL)
    // that paralleled DAG step labels — the queries throw on absence.
    // Phase pills (the "pending" pill for "Main" phase) should NOT appear.
    expect(screen.queryByText("Main")).toBeNull();
  });

  it("renders the inputs pipeline card with key=value pills", () => {
    const ref: { current: ProbeHandle | null } = { current: null };
    render(
      <Probe ref={ref} initialData={{ phase: "running", runId: "run-pipe" }} />,
    );

    const snapshot: RoutineRunSnapshot = {
      runId: "run-pipe",
      routineId: "demo",
      routineName: "Demo routine",
      state: "running",
      inputs: { topic: "AI safety", depth: 3 },
      phases: [
        {
          phaseId: "p1",
          label: "Research",
          state: "running",
          steps: [{ stepId: "s1", label: "Find" }],
        },
      ],
      startedAt: "2026-04-26T00:00:00.000Z",
    };

    act(() => {
      ref.current!.emit({ type: "routine_progress", runId: "run-pipe", snapshot });
    });

    // Inputs card renders both inputs as labelled pills.
    const inputsCard = screen.getByLabelText("Inputs");
    expect(inputsCard.textContent).toContain("topic");
    expect(inputsCard.textContent).toContain("AI safety");
    expect(inputsCard.textContent).toContain("depth");
    expect(inputsCard.textContent).toContain("3");
  });

  // Removed `renders a handoff inspector listing step outputs and facts`
  // (§5.5 TRIVIAL): every assertion was `getBy*(...).toBeTruthy()` smoke;
  // the queries already throw on absence.

  it("ignores routine_step_leader_spawned for a different runId", () => {
    const spawnFn = vi.fn();
    const ref: { current: ProbeHandle | null } = { current: null };
    render(
      <Probe
        ref={ref}
        onSpawnLeaderChild={spawnFn}
        initialData={{ phase: "running", runId: "run-abc" }}
      />,
    );

    act(() => {
      ref.current!.emit({
        type: "routine_step_leader_spawned",
        runId: "run-OTHER",
        phaseId: "p1",
        stepId: "s1",
        sessionKey: "leader-session-2",
      });
    });

    expect(spawnFn).not.toHaveBeenCalled();
  });
});
