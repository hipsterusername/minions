/**
 * Regression: the in-progress minion badge pulse must actually animate.
 *
 * The `minion-pulse` keyframes MUST be present in the document *before* a
 * running minion's badge first paints. They used to be injected inside a
 * per-instance `useEffect`, which runs only after the first paint — and
 * browsers do not retroactively start an animation whose `animation-name`
 * resolved to an empty keyframe set at paint time. The result was a badge
 * frozen at opacity 1 (no pulse) for the first minion to appear.
 *
 * These tests lock in the module-load injection so the keyframes exist
 * eagerly, independent of any MinionNode instance mounting.
 */

import { render } from "@testing-library/react";
import { describe, expect, it, beforeAll } from "vitest";

import {
  MinionNodeRenderer,
  injectPulseKeyframes,
  type MinionData,
} from "./MinionNode.tsx";
import type { CanvasNode, NodeRenderProps } from "../types.ts";
import { MINION_THINKING_CONFIG } from "../types.ts";

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

const KEYFRAME_ID = "minion-pulse-keyframes";

function runningData(overrides: Partial<MinionData> = {}): MinionData {
  return {
    sessionKey: "m-a",
    status: "running",
    leaderId: null,
    taskQueue: [],
    activeTaskIndex: -1,
    messages: [],
    streamingText: "",
    totalCost: 0,
    turns: 0,
    error: null,
    model: "sonnet",
    permissionMode: "auto",
    thinkingConfig: { ...MINION_THINKING_CONFIG },
    ...overrides,
  };
}

describe("MinionNode in-progress pulse animation", () => {
  it("injects the minion-pulse keyframes at module load, before any node mounts", () => {
    // Importing MinionNode.tsx runs injectPulseKeyframes() at module eval.
    const style = document.getElementById(KEYFRAME_ID);
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain("@keyframes minion-pulse");
  });

  it("injectPulseKeyframes is idempotent (single <style> element)", () => {
    injectPulseKeyframes();
    injectPulseKeyframes();
    const matches = document.querySelectorAll(`#${KEYFRAME_ID}`);
    expect(matches.length).toBe(1);
  });

  it("keyframes are already present when a running minion badge renders", () => {
    // The badge references `minion-pulse` in its inline animation. The keyframe
    // rule must exist in the document at render time for the browser to start
    // the animation on first paint.
    const node: CanvasNode = {
      id: "m",
      type: "minion",
      position: { x: 0, y: 0 },
      size: { width: 340, height: 200 },
      data: runningData(),
    };
    const props: NodeRenderProps = {
      node,
      isSelected: false,
      onUpdateData: () => {},
      socketSubscribe: (() => () => {}) as never,
      socketSend: () => {},
    };
    const { container } = render(<MinionNodeRenderer {...props} />);

    const badge = Array.from(
      container.querySelectorAll<HTMLElement>("*"),
    ).find((el) => (el.style.animation || "").includes("minion-pulse"));

    expect(badge).toBeDefined();
    expect(badge?.style.animation).toContain("minion-pulse");
    // Keyframes present at render time — not deferred to a post-paint effect.
    expect(document.getElementById(KEYFRAME_ID)).not.toBeNull();
  });

  it("idle minions do not apply the pulse animation", () => {
    const node: CanvasNode = {
      id: "m2",
      type: "minion",
      position: { x: 0, y: 0 },
      size: { width: 340, height: 200 },
      data: runningData({ status: "idle" }),
    };
    const props: NodeRenderProps = {
      node,
      isSelected: false,
      onUpdateData: () => {},
      socketSubscribe: (() => () => {}) as never,
      socketSend: () => {},
    };
    const { container } = render(<MinionNodeRenderer {...props} />);
    const pulsing = Array.from(
      container.querySelectorAll<HTMLElement>("*"),
    ).filter((el) => (el.style.animation || "").includes("minion-pulse"));
    expect(pulsing.length).toBe(0);
  });
});
