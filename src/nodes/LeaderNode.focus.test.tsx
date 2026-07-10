/**
 * Regression: a freshly created leader node hands focus to its prompt input.
 *
 * Canvas registers a one-shot focus request (via requestLeaderInputFocus) when
 * the user creates an empty leader node. On mount, LeaderNodeRenderer must
 * claim that request and focus the inline prompt textarea — but only when a
 * request exists, so rehydrated nodes (page reload) are left untouched.
 */

import { render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { LeaderNodeRenderer, type LeaderData } from "./LeaderNode.tsx";
import type { CanvasNode, NodeRenderProps } from "../types.ts";
import { DEFAULT_THINKING_CONFIG } from "../types.ts";
import {
  requestLeaderInputFocus,
  resetLeaderInputFocusRequestsForTests,
} from "../leader-focus-request.ts";

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(() => {
  resetLeaderInputFocusRequestsForTests();
});

function leaderData(overrides: Partial<LeaderData> = {}): LeaderData {
  return {
    sessionKey: null,
    status: "disconnected",
    messages: [],
    streamingText: "",
    streamingBlockIndex: null,
    totalCost: 0,
    turns: 0,
    error: null,
    model: "opus",
    permissionMode: "bypassPermissions",
    thinkingConfig: { ...DEFAULT_THINKING_CONFIG },
    taskPlan: [],
    worktreeIsolation: false,
    worktreePath: null,
    worktreeBranch: null,
    worktreeStatus: "none",
    skillIds: [],
    skillValues: {},
    skillPanelOpen: false,
    ...overrides,
  };
}

function renderLeader(nodeId: string) {
  function Probe() {
    const [data, setData] = useState<LeaderData>(leaderData());
    const node: CanvasNode = {
      id: nodeId,
      type: "leader",
      position: { x: 0, y: 0 },
      size: { width: 480, height: 400 },
      data,
    };
    const props: NodeRenderProps = {
      node,
      isSelected: false,
      onUpdateData: (next) => setData(next as LeaderData),
      socketSubscribe: () => () => {},
      socketSend: () => {},
    };
    return <LeaderNodeRenderer {...props} />;
  }
  render(<Probe />);
}

describe("LeaderNode prompt auto-focus", () => {
  it("focuses the prompt input when a focus request was registered", () => {
    requestLeaderInputFocus("leader-focus-1");
    renderLeader("leader-focus-1");

    const textarea = screen.getByTestId("leader-prompt-input-inline");
    expect(document.activeElement).toBe(textarea);
  });

  it("does not focus the prompt input without a request (rehydrated node)", () => {
    renderLeader("leader-focus-2");

    const textarea = screen.getByTestId("leader-prompt-input-inline");
    expect(document.activeElement).not.toBe(textarea);
  });
});
