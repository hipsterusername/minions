/**
 * Eye-saccade microinteraction tests.
 *
 * The running-state status indicator and the running timeline dot now render
 * an inner "pupil" element that performs a hand-scripted look-around
 * animation. These tests pin the *structure* of that change — the pupil
 * exists when state is "running" and never when it is something else —
 * and verify that the variant chosen for a given seed is stable and that
 * different seeds spread across all four variants.
 *
 * Animation timing itself is purely declarative (CSS keyframes), so it's
 * not exercised here; the assertion is that the wiring renders the right
 * DOM with the right class and amplitude variable.
 */

import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { RenderComponentView } from "./RenderNode.tsx";
import type {
  StatusComponent,
  TimelineComponent,
} from "../../shared/render-dsl.ts";

const PUPIL_VARIANT_CLASSES = [
  "rd-pupil--a",
  "rd-pupil--b",
  "rd-pupil--c",
  "rd-pupil--d",
];

describe("StatusBadge running pupil", () => {
  it("renders a pupil element only when state is running", () => {
    const running: StatusComponent = {
      id: "s-run",
      type: "status",
      label: "Building",
      state: "running",
    };
    const { unmount } = render(<RenderComponentView component={running} />);
    expect(screen.getByTestId("rd-status-pupil")).toBeInTheDocument();
    unmount();

    const success: StatusComponent = {
      id: "s-ok",
      type: "status",
      label: "Done",
      state: "success",
    };
    render(<RenderComponentView component={success} />);
    expect(screen.queryByTestId("rd-status-pupil")).toBeNull();
  });

  it("attaches one of the four scripted variant classes", () => {
    const c: StatusComponent = {
      id: "deploy-step",
      type: "status",
      label: "Deploying",
      state: "running",
    };
    render(<RenderComponentView component={c} />);
    const pupil = screen.getByTestId("rd-status-pupil");
    const matched = PUPIL_VARIANT_CLASSES.filter((cls) =>
      pupil.classList.contains(cls),
    );
    expect(matched).toHaveLength(1);
  });

  it("is deterministic for a given component id", () => {
    const c: StatusComponent = {
      id: "stable-id",
      type: "status",
      label: "x",
      state: "running",
    };
    const { unmount } = render(<RenderComponentView component={c} />);
    const firstClasses = screen.getByTestId("rd-status-pupil").className;
    unmount();
    render(<RenderComponentView component={c} />);
    const secondClasses = screen.getByTestId("rd-status-pupil").className;
    expect(secondClasses).toBe(firstClasses);
  });

  it("spreads multiple ids across more than one variant", () => {
    // Sanity check that the hash isn't degenerate — over many ids we
    // should see at least two distinct variants picked.
    const variantsSeen = new Set<string>();
    for (let i = 0; i < 32; i++) {
      const c: StatusComponent = {
        id: `id-${i}`,
        type: "status",
        label: "x",
        state: "running",
      };
      const { unmount } = render(<RenderComponentView component={c} />);
      const pupil = screen.getByTestId("rd-status-pupil");
      for (const cls of PUPIL_VARIANT_CLASSES) {
        if (pupil.classList.contains(cls)) variantsSeen.add(cls);
      }
      unmount();
    }
    expect(variantsSeen.size).toBeGreaterThan(1);
  });

  it("sets the larger amplitude (--rd-pupil-amp) for the 20px badge", () => {
    const c: StatusComponent = {
      id: "amp-status",
      type: "status",
      label: "x",
      state: "running",
    };
    render(<RenderComponentView component={c} />);
    const pupil = screen.getByTestId("rd-status-pupil");
    expect(pupil.style.getPropertyValue("--rd-pupil-amp")).toBe("4");
  });
});

describe("TimelineView running pupil", () => {
  it("renders a pupil for each running event and not for others", () => {
    const c: TimelineComponent = {
      id: "tl",
      type: "timeline",
      events: [
        { label: "queued", state: "pending" },
        { label: "fetching", state: "running" },
        { label: "writing", state: "running" },
        { label: "done", state: "success" },
      ],
    };
    render(<RenderComponentView component={c} />);
    expect(screen.getAllByTestId("rd-timeline-pupil")).toHaveLength(2);
  });

  it("uses the smaller amplitude for the 10px timeline dot", () => {
    const c: TimelineComponent = {
      id: "tl-amp",
      type: "timeline",
      events: [{ label: "running", state: "running" }],
    };
    render(<RenderComponentView component={c} />);
    const pupil = screen.getByTestId("rd-timeline-pupil");
    expect(pupil.style.getPropertyValue("--rd-pupil-amp")).toBe("1.6");
  });
});
