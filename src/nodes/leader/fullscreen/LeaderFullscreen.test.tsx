/**
 * Behavior tests for the Leader fullscreen cockpit.
 *
 * Mirrors the test patterns from `MarkdownNode.test.tsx`'s focus-mode
 * suite: confirms toggle-button + keyboard-shortcut + Esc semantics,
 * portal mount target, body-scroll lock, and that the 3-pane cockpit
 * shell renders the activity rail, conversation, and context drawer.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeAll, describe, expect, it } from "vitest";

import { LeaderNodeRenderer } from "../../LeaderNode.tsx";
import { LEADER_DEFAULT_DATA, type LeaderData } from "../types.ts";
import type { CanvasNode, NodeRenderProps } from "../../../types.ts";

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

interface ProbeProps {
  initial?: Partial<LeaderData>;
}

function Probe({ initial }: ProbeProps) {
  const [data, setData] = useState<LeaderData>({
    ...LEADER_DEFAULT_DATA,
    ...initial,
  });
  const node: CanvasNode = {
    id: "leader-fs-test",
    type: "leader",
    position: { x: 0, y: 0 },
    size: { width: 560, height: 520 },
    data,
  };
  const props: NodeRenderProps = {
    node,
    isSelected: false,
    onUpdateData: (next) => setData(next as LeaderData),
    socketSend: () => {
      /* no-op — fullscreen tests don't exercise the WS */
    },
    socketSubscribe: () => () => {
      /* no-op subscription */
    },
  };
  return <LeaderNodeRenderer {...props} />;
}

describe("LeaderNode fullscreen cockpit", () => {
  it("does not render the overlay by default", () => {
    render(<Probe />);
    expect(
      document.querySelector("[data-testid='leader-fullscreen-overlay']"),
    ).toBeNull();
    // Header still shows the enter-fullscreen button.
    expect(
      screen.getByRole("button", { name: "Enter fullscreen" }),
    ).toBeInTheDocument();
  });

  it("clicking the fullscreen button portals the cockpit and locks body scroll", async () => {
    render(<Probe />);

    const enter = screen.getByRole("button", { name: "Enter fullscreen" });
    expect(enter).toHaveAttribute("aria-pressed", "false");

    await act(async () => {
      fireEvent.click(enter);
    });

    const overlay = document.querySelector(
      "[data-testid='leader-fullscreen-overlay']",
    );
    expect(overlay).not.toBeNull();
    // Portal target is document.body — escapes the canvas CSS transform.
    expect(overlay?.parentElement).toBe(document.body);

    // 3-pane structure is present.
    expect(
      overlay?.querySelector("[data-testid='leader-fullscreen-activity-rail']"),
    ).not.toBeNull();
    expect(
      overlay?.querySelector("[data-testid='leader-fullscreen-conversation']"),
    ).not.toBeNull();
    expect(
      overlay?.querySelector(
        "[data-testid='leader-fullscreen-context-drawer']",
      ),
    ).not.toBeNull();

    // Body scroll lock engaged.
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("Esc exits the cockpit and restores body scroll", async () => {
    render(<Probe />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    });
    expect(
      document.querySelector("[data-testid='leader-fullscreen-overlay']"),
    ).not.toBeNull();

    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });

    expect(
      document.querySelector("[data-testid='leader-fullscreen-overlay']"),
    ).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  it("Cmd+Shift+F toggles the cockpit when the leader node owns focus", async () => {
    render(<Probe />);

    // The cockpit toggle is scoped to the leader's root by focus ownership.
    // Move focus onto the enter-fullscreen button (lives inside the node root)
    // so the keyboard shortcut applies.
    const enter = screen.getByRole("button", { name: "Enter fullscreen" });
    enter.focus();

    await act(async () => {
      fireEvent.keyDown(window, {
        key: "f",
        metaKey: true,
        shiftKey: true,
      });
    });
    expect(
      document.querySelector("[data-testid='leader-fullscreen-overlay']"),
    ).not.toBeNull();

    // Once the overlay is up the shortcut closes it from anywhere.
    await act(async () => {
      fireEvent.keyDown(window, {
        key: "f",
        metaKey: true,
        shiftKey: true,
      });
    });
    expect(
      document.querySelector("[data-testid='leader-fullscreen-overlay']"),
    ).toBeNull();
  });

  it("exit button closes the cockpit", async () => {
    render(<Probe />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    });

    const exit = screen.getByTestId("leader-fullscreen-exit");
    expect(exit).toHaveAttribute("aria-pressed", "true");

    await act(async () => {
      fireEvent.click(exit);
    });
    expect(
      document.querySelector("[data-testid='leader-fullscreen-overlay']"),
    ).toBeNull();
  });

  it("renders the conversation header (status pill) and composer inside the cockpit", async () => {
    render(<Probe initial={{ taskName: "Build the cockpit", turns: 3 }} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    });

    const overlay = document.querySelector(
      "[data-testid='leader-fullscreen-overlay']",
    );
    // Title surfaces in the header.
    expect(overlay?.textContent).toContain("Build the cockpit");
    // Composer is mounted at the bottom of the conversation pane.
    expect(
      overlay?.querySelector(
        "[data-testid='leader-prompt-bar-inline']",
      ),
    ).not.toBeNull();
  });

  it("renders all five context-drawer tabs", async () => {
    render(<Probe />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    });

    for (const id of ["overview", "worktree", "approval", "skills", "prompt"]) {
      expect(screen.getByTestId(`drawer-tab-${id}`)).toBeInTheDocument();
    }
    // Default tab is "overview" since no approval is pending.
    expect(screen.getByTestId("drawer-panel-overview")).toBeInTheDocument();
  });

  it("activity rail renders a minion roster derived from taskPlan", async () => {
    render(
      <Probe
        initial={{
          taskPlan: [
            {
              taskId: "t1",
              title: "Investigate auth bug",
              description: "",
              priority: "high",
              status: "running",
              executor: "minion",
              minionSessionKey: "minion-alpha",
              result: null,
              cost: 0.012,
              createdAt: Date.now(),
              completedAt: null,
              sessionSummary: "",
              activeStep: "Reading auth.ts",
            },
            {
              taskId: "t2",
              title: "Self-review",
              description: "",
              priority: "low",
              status: "planned",
              executor: "leader",
              minionSessionKey: null,
              result: null,
              cost: 0,
              createdAt: Date.now(),
              completedAt: null,
              sessionSummary: "",
            },
          ],
        }}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    });

    const roster = screen.getByTestId("leader-fullscreen-minion-roster");
    // Only the minion-executor task shows up in the roster.
    expect(roster.textContent).toContain("Investigate auth bug");
    expect(roster.textContent).not.toContain("Self-review");
    // Active step appears for running minions.
    expect(roster.textContent).toContain("Reading auth.ts");
    // Click the row → fires reveal callback (no-op here, just verify the
    // testid was emitted from the row).
    expect(screen.getByTestId("minion-row-minion-alpha")).toBeInTheDocument();
  });

  it("renders both pane dividers and they can be activated via pointer-down", async () => {
    render(<Probe />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    });

    const leftDivider = screen.getByTestId("leader-fullscreen-divider-left");
    const rightDivider = screen.getByTestId("leader-fullscreen-divider-right");
    expect(leftDivider).toHaveAttribute("role", "separator");
    expect(rightDivider).toHaveAttribute("role", "separator");

    // A pointer-down activates the drag without throwing — verifying the
    // pointer-capture path works in the test environment.
    await act(async () => {
      fireEvent.pointerDown(leftDivider, { clientX: 260, pointerId: 1 });
      fireEvent.pointerMove(leftDivider, { clientX: 320, pointerId: 1 });
      fireEvent.pointerUp(leftDivider, { clientX: 320, pointerId: 1 });
    });
  });

  it("Overview tab shows hero metrics and a task progress bar", async () => {
    render(
      <Probe
        initial={{
          turns: 5,
          totalCost: 0.0421,
          taskPlan: [
            {
              taskId: "a",
              title: "a",
              description: "",
              priority: "low",
              status: "completed",
              executor: "leader",
              minionSessionKey: null,
              result: null,
              cost: 0,
              createdAt: 0,
              completedAt: 1,
              sessionSummary: "",
            },
            {
              taskId: "b",
              title: "b",
              description: "",
              priority: "low",
              status: "running",
              executor: "leader",
              minionSessionKey: null,
              result: null,
              cost: 0,
              createdAt: 0,
              completedAt: null,
              sessionSummary: "",
            },
          ],
        }}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    });

    const panel = screen.getByTestId("drawer-panel-overview");
    // Hero metrics — cost is the dollar amount, turns is a number.
    expect(panel.textContent).toContain("$0.042");
    expect(panel.textContent).toContain("5");
    // Progress label shows done/total + per-turn cost hint.
    expect(panel.textContent).toContain("1/2");
    expect(panel.textContent).toContain("/turn");
  });

  it("auto-selects the Approval tab when an approval is pending", async () => {
    render(
      <Probe
        initial={{
          approvalPending: true,
          approvalSummary: "ready to ship",
          approvalDiff: {
            filesChanged: 3,
            insertions: 42,
            deletions: 7,
            files: [],
            commits: ["abc1234"],
            branch: "feature/x",
          },
        }}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    });

    expect(screen.getByTestId("drawer-panel-approval")).toBeInTheDocument();
    expect(screen.getByTestId("drawer-panel-approval").textContent).toContain(
      "ready to ship",
    );
  });
});
