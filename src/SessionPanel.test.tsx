/**
 * Component tests for `SessionPanel` usage section wiring.
 *
 * The panel is a thin shell over `usage-aggregator`; we verify the
 * integration glue:
 *   - expanding the panel reveals the usage section
 *   - SDK result events for arbitrary sessions feed the usage section (the
 *     panel subscribes globally, not per-session)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { SessionPanel } from "./SessionPanel.tsx";
import type { ServerMessage, SdkResultSuccess } from "./use-socket.ts";

let listeners: Array<(msg: unknown) => void> = [];

function subscribe(fn: (msg: unknown) => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

function emit(msg: ServerMessage) {
  for (const l of listeners) l(msg as unknown);
}

function makeResult(
  cost: number,
  modelUsage: Record<string, number>,
): SdkResultSuccess {
  const mu: SdkResultSuccess["modelUsage"] = {};
  for (const [model, costUSD] of Object.entries(modelUsage)) {
    mu[model] = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD,
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
    };
  }
  return {
    type: "result",
    subtype: "success",
    result: "ok",
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    stop_reason: "end_turn",
    total_cost_usd: cost,
    usage: { input_tokens: 100, output_tokens: 50 },
    modelUsage: mu,
    permission_denials: [],
    uuid: "u",
    session_id: "s",
  };
}

function expandPanel() {
  fireEvent.click(screen.getByTestId("sessions-expand"));
}

beforeEach(() => {
  listeners = [];
});

describe("SessionPanel usage section", () => {
  it("shows the usage section with empty-state copy when panel is expanded", () => {
    render(
      <SessionPanel
        socketSubscribe={subscribe}
        onAttachSession={() => {}}
        attachedSessionKeys={new Set()}
      />,
    );
    expandPanel();
    expect(screen.getByTestId("usage-section")).toBeDefined();
    expect(screen.getByText(/No usage recorded yet/i)).toBeDefined();
  });

  it("aggregates SDK result events and renders per-model rows in the panel", () => {
    render(
      <SessionPanel
        socketSubscribe={subscribe}
        onAttachSession={() => {}}
        attachedSessionKeys={new Set()}
      />,
    );

    act(() => {
      emit({
        type: "sdk_event",
        sessionKey: "leader-1",
        message: makeResult(0.5, { "claude-sonnet-4-20250514": 0.5 }),
      });
      emit({
        type: "sdk_event",
        sessionKey: "minion-2",
        message: makeResult(1.5, { "claude-opus-4-1-20250805": 1.5 }),
      });
    });

    expandPanel();
    expect(screen.getByTestId("usage-row-opus-4-1")).toBeDefined();
    expect(screen.getByTestId("usage-row-sonnet-4")).toBeDefined();
    expect(screen.getByText("$2.0000")).toBeDefined();
    expect(screen.getByText("2 sessions")).toBeDefined();
  });

  it("usage section is not visible when panel is collapsed", () => {
    render(
      <SessionPanel
        socketSubscribe={subscribe}
        onAttachSession={() => {}}
        attachedSessionKeys={new Set()}
      />,
    );
    // Panel starts collapsed — usage section should not be in the DOM
    expect(screen.queryByTestId("usage-section")).toBeNull();
  });
});
