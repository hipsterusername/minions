import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { DialecticNodeRenderer, createDialecticDefaultData, reduce, type DialecticData } from "./DialecticNode.tsx";
import { getNodeType } from "../node-registry.ts";
import type { CanvasNode, NodeRenderProps } from "../types.ts";
import { HarnessListProvider } from "../use-harness-list.tsx";
import type { HarnessListEntry } from "../use-socket.ts";
import type { DialecticEvent } from "../../shared/dialectic.ts";

const CAPS = {
  mutationInterception: "complete",
  thinking: true,
  promptCaching: true,
  mcp: true,
  permissionPrompts: true,
  resume: true,
  partialMessages: true,
  builtInFilesystem: true,
} as const;

const CLAUDE_ENTRY: HarnessListEntry = {
  name: "claude",
  capabilities: CAPS,
  builtInTools: [],
  models: [
    { id: "claude-opus-4-8", label: "Opus 4.8" },
    { id: "claude-sonnet-5", label: "Sonnet 5" },
  ],
  commands: [],
  agents: [],
  account: { provider: "claude" },
};

const CODEX_ENTRY: HarnessListEntry = {
  name: "codex",
  capabilities: { ...CAPS, mutationInterception: "observe_only" },
  builtInTools: [],
  models: [
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  ],
  commands: [],
  agents: [],
  account: { provider: "openai" },
};

function makeNode(data: Partial<DialecticData> = {}): CanvasNode {
  return {
    id: "node-x",
    type: "dialectic",
    position: { x: 0, y: 0 },
    size: { width: 620, height: 560 },
    data: { ...createDialecticDefaultData(), ...data },
  };
}

function renderNode(
  node: CanvasNode,
  overrides: Partial<NodeRenderProps> = {},
  harnesses?: HarnessListEntry[],
) {
  const onUpdateData = vi.fn();
  const socketSend = vi.fn();
  const props: NodeRenderProps = {
    node,
    isSelected: false,
    onUpdateData,
    socketSend,
    socketSubscribe: undefined,
    projectPath: "/repo",
    ...overrides,
  };
  let subscriber: ((m: unknown) => void) | null = null;
  const subscribe = (fn: (m: unknown) => void) => {
    subscriber = fn;
    return () => {
      subscriber = null;
    };
  };
  render(
    <HarnessListProvider send={vi.fn()} subscribe={subscribe} connected={true}>
      <DialecticNodeRenderer {...props} />
    </HarnessListProvider>,
  );
  if (harnesses) {
    act(() => {
      subscriber?.({ type: "harness_list", harnesses });
    });
  }
  return { onUpdateData, socketSend };
}

describe("DialecticNode registration", () => {
  it("is registered, user-creatable, and gated by the dialectic flag", () => {
    const def = getNodeType("dialectic");
    expect(def).toBeDefined();
    expect(def!.userCreatable).toBe(true);
    expect(def!.flag).toBe("dialectic");
    expect(def!.providesContext).toBe(true);
  });

  it("extractContent prefers the synthesis document", () => {
    const def = getNodeType("dialectic")!;
    expect(def.extractContent!({ synthesis: "THE PLAN" } as unknown)).toBe("THE PLAN");
    expect(def.extractContent!(createDialecticDefaultData() as unknown)).toBeNull();
  });
});

describe("DialecticNode component", () => {
  beforeEach(() => {
    // jsdom doesn't implement scrollIntoView; harmless no-op.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("sends start_dialectic with the configured topic + config", () => {
    const node = makeNode({ topic: "Cache design" });
    const { socketSend, onUpdateData } = renderNode(node);
    fireEvent.click(screen.getByText(/Start dialectic/i));
    expect(socketSend).toHaveBeenCalledTimes(1);
    const payload = socketSend.mock.calls[0]![0] as {
      type: string;
      sessionKey: string;
      cwd: string;
      prompt: string;
      dialecticConfig: unknown;
    };
    expect(payload.type).toBe("start_dialectic");
    expect(payload.sessionKey).toBe("node-x");
    expect(payload.cwd).toBe("/repo");
    expect(payload.prompt).toBe("Cache design");
    expect(payload.dialecticConfig).toMatchObject({ mode: "ping-pong", rounds: 3 });
    // Optimistically flips to running.
    expect(onUpdateData).toHaveBeenCalledWith(expect.objectContaining({ status: "running" }));
  });

  it("disables start when the topic is empty", () => {
    const { socketSend } = renderNode(makeNode({ topic: "" }));
    const btn = screen.getByText(/Start dialectic/i) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(socketSend).not.toHaveBeenCalled();
  });

  it("renders both planner transcripts and the synthesized plan", () => {
    const node = makeNode({
      status: "completed",
      turns: [
        { speaker: "A", round: 0, text: "A says alpha" },
        { speaker: "B", round: 0, text: "B says beta" },
      ],
      synthesis: "Final merged plan",
    });
    renderNode(node);
    expect(screen.getByText("A says alpha")).toBeInTheDocument();
    expect(screen.getByText("B says beta")).toBeInTheDocument();
    expect(screen.getByText("Final merged plan")).toBeInTheDocument();
    expect(screen.getByText("Synthesized plan")).toBeInTheDocument();
  });

  it("captures canvas scrolling and accepts keyboard focus", () => {
    renderNode(makeNode());
    const workspace = screen.getByTestId("dialectic-node");
    expect(workspace).toHaveAttribute("data-scroll-capture");
    expect(workspace).toHaveAttribute("tabindex", "0");
  });

  it("shows the exact context communicated to the critic", () => {
    const node = makeNode({
      topic: "Cache design",
      status: "running",
      config: {
        ...createDialecticDefaultData().config,
        mode: "proposer-critic",
      },
      turns: [
        { speaker: "A", round: 0, text: "Use a two-tier cache." },
        {
          speaker: "B",
          round: 0,
          text: "",
          context: {
            systemPrompt: "Your role: CRITIC. Stress-test the plan.",
            prompt: "The proposer's latest plan:\n\nUse a two-tier cache.",
            retainedThread: false,
          },
        },
      ],
      activeSpeaker: "B",
      activeRound: 0,
    });
    renderNode(node);

    const criticContext = screen.getByText("Inspect exact input to Critic").closest("details");
    expect(criticContext).toBeInTheDocument();
    expect(criticContext).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("Inspect exact input to Critic"));
    expect(criticContext).toHaveAttribute("open");
    expect(screen.getByText("Your role: CRITIC. Stress-test the plan.")).toBeInTheDocument();
    expect(screen.getByText(/The proposer's latest plan:/)).toHaveTextContent(
      "Use a two-tier cache.",
    );
    expect(screen.getByText(/Private hidden chain-of-thought is not available/i)).toBeInTheDocument();
    expect(screen.getByText(/Proposer output becomes new input for Critic/i)).toBeInTheDocument();
  });

  it("labels resumed context without pretending to resend the full thread", () => {
    const node = makeNode({
      status: "completed",
      turns: [
        {
          speaker: "A",
          round: 1,
          text: "Revised plan",
          context: {
            prompt: "The critic reviewed your latest plan: fix invalidation.",
            retainedThread: true,
          },
        },
      ],
    });
    renderNode(node);
    expect(
      screen.getByText("Continuing session · 1 earlier Planner A turn retained"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Only the new message is shown; earlier session history remains retained/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("Role instructions")).not.toBeInTheDocument();
  });

  it("shows one round at a time and lets the user inspect earlier exchanges", () => {
    const node = makeNode({
      status: "completed",
      config: { ...createDialecticDefaultData().config, rounds: 2 },
      turns: [
        { speaker: "A", round: 0, text: "Round one proposal" },
        { speaker: "B", round: 0, text: "Round one critique" },
        {
          speaker: "A",
          round: 1,
          text: "Round two revision",
          context: {
            prompt: "Apply the prior critique.",
            retainedThread: true,
          },
        },
        { speaker: "B", round: 1, text: "Round two approval" },
      ],
    });
    renderNode(node);

    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Round 2 of 2");
    expect(screen.getByText("Round two revision")).toBeInTheDocument();
    expect(screen.queryByText("Round one proposal")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /R1/i }));
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Round 1 of 2");
    expect(screen.getByText("Round one proposal")).toBeInTheDocument();
    expect(screen.queryByText("Round two revision")).not.toBeInTheDocument();
  });

  it("shows a Stop button while running and sends stop_dialectic", () => {
    const node = makeNode({ topic: "x", status: "running" });
    const { socketSend } = renderNode(node);
    fireEvent.click(screen.getByText(/^Stop$/));
    expect(socketSend).toHaveBeenCalledWith({ type: "stop_dialectic", sessionKey: "node-x" });
  });
});

describe("DialecticNode planner pickers", () => {
  it("surfaces models from every registered harness, including GPT/Codex", () => {
    renderNode(makeNode(), {}, [CLAUDE_ENTRY, CODEX_ENTRY]);
    // Both planner selects should offer the Codex GPT models sourced from the
    // shared harness registry — proving new harness models appear automatically.
    expect(screen.getAllByRole("option", { name: "GPT-5.6 Sol" }).length).toBe(2);
    expect(screen.getAllByRole("option", { name: "GPT-5.6 Luna" }).length).toBe(2);
    expect(screen.getAllByRole("option", { name: "Opus 4.8" }).length).toBe(2);
  });

  it("selecting a GPT model updates both harness and model for that planner", () => {
    const { onUpdateData } = renderNode(makeNode(), {}, [CLAUDE_ENTRY, CODEX_ENTRY]);
    const selects = screen.getAllByRole("combobox");
    // Planner A is the first planner picker (mode select precedes it).
    const plannerA = selects.find((s) =>
      Array.from((s as HTMLSelectElement).options).some((o) => o.text === "GPT-5.6 Sol"),
    ) as HTMLSelectElement;
    fireEvent.change(plannerA, { target: { value: "codex gpt-5.6-sol" } });
    const updated = onUpdateData.mock.calls.at(-1)![0] as DialecticData;
    expect(updated.config.plannerA).toEqual({ harness: "codex", model: "gpt-5.6-sol" });
  });

  it("keeps an unknown persisted selection visible as a fallback option", () => {
    const node = makeNode();
    (node.data as DialecticData).config.plannerA = { harness: "codex", model: "gpt-legacy" };
    renderNode(node, {}, [CLAUDE_ENTRY, CODEX_ENTRY]);
    expect(screen.getByRole("option", { name: "gpt-legacy (codex)" })).toBeInTheDocument();
  });
});

describe("DialecticNode reduce()", () => {
  const base = (): DialecticData => ({
    ...createDialecticDefaultData(),
    status: "running",
  });

  it("stores the turn_started context as a placeholder, then carries it forward onto turn_completed", () => {
    const started: DialecticEvent = {
      kind: "turn_started",
      speaker: "B",
      round: 0,
      context: {
        systemPrompt: "Your role: CRITIC.",
        prompt: "The proposer's latest plan:\n\nUse a two-tier cache.",
        retainedThread: false,
      },
    };
    const afterStart = reduce(base(), started);
    const placeholder = afterStart.turns.find((t) => t.speaker === "B" && t.round === 0);
    expect(placeholder).toMatchObject({ text: "", context: started.context });
    expect(afterStart.activeSpeaker).toBe("B");
    expect(afterStart.activeRound).toBe(0);

    const completed: DialecticEvent = {
      kind: "turn_completed",
      speaker: "B",
      round: 0,
      text: "The cache design has a stale-invalidation gap.",
    };
    const afterComplete = reduce(afterStart, completed);
    expect(afterComplete.turns).toHaveLength(1);
    expect(afterComplete.turns[0]).toMatchObject({
      speaker: "B",
      round: 0,
      text: "The cache design has a stale-invalidation gap.",
      // The completed event itself carries no context — it must be preserved
      // from the turn_started placeholder, not dropped.
      context: started.context,
    });
    expect(afterComplete.activeSpeaker).toBeNull();
  });

  it("replaces a same (speaker, round) turn idempotently rather than duplicating it", () => {
    const started: DialecticEvent = { kind: "turn_started", speaker: "A", round: 2 };
    const restarted: DialecticEvent = { kind: "turn_started", speaker: "A", round: 2 };
    const next = reduce(reduce(base(), started), restarted);
    expect(next.turns.filter((t) => t.speaker === "A" && t.round === 2)).toHaveLength(1);
  });

  it("tolerates a turn_completed with no matching turn_started and no context (legacy/replayed events)", () => {
    const completed: DialecticEvent = {
      kind: "turn_completed",
      speaker: "A",
      round: 0,
      text: "Older-coordinator turn with no prior context event.",
    };
    const next = reduce(base(), completed);
    expect(next.turns).toEqual([
      { speaker: "A", round: 0, text: "Older-coordinator turn with no prior context event." },
    ]);
  });
});
