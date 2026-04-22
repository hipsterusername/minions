/**
 * AnnotationLayer — pin and rectangle creation, pin drag, selection.
 *
 * Covers the behavior contract described in docs/visual-context-plan.md
 * Phase 3's in-flight gates: pin add/move/delete and rect drag-to-create.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeAll } from "vitest";
import { useState } from "react";

import {
  AnnotationLayer,
  type Annotation,
  type AnnotationTool,
} from "./AnnotationLayer.tsx";

beforeAll(() => {
  // jsdom doesn't implement pointer capture; stub it so the component
  // can call it during tests without throwing.
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = function () {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = function () {};
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = function (): boolean { return false; };
  }
});

interface HarnessProps {
  initial: Annotation[];
  tool: AnnotationTool;
  onAdd?: (a: Annotation) => void;
  onUpdate?: (id: string, patch: Partial<Annotation>) => void;
  onSelect?: (id: string | null) => void;
}

/**
 * Host that keeps annotations in state so updates round-trip, but exposes
 * the raw onAdd/onUpdate/onSelect callbacks for direct assertion (avoiding
 * closure-staleness in assertions).
 */
function Harness({ initial, tool, onAdd, onUpdate, onSelect }: HarnessProps) {
  const [annotations, setAnnotations] = useState<Annotation[]>(initial);
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div style={{ width: 200, height: 200, position: "relative" }}>
      <AnnotationLayer
        annotations={annotations}
        tool={tool}
        defaultColor="#3b82f6"
        selectedId={selected}
        onSelect={(id) => {
          setSelected(id);
          onSelect?.(id);
        }}
        onAdd={(a) => {
          setAnnotations((prev) => [...prev, a]);
          onAdd?.(a);
        }}
        onUpdate={(id, patch) => {
          setAnnotations((prev) =>
            prev.map((a) => (a.id === id ? ({ ...a, ...patch } as Annotation) : a)),
          );
          onUpdate?.(id, patch);
        }}
      />
    </div>
  );
}

/** Build a DOMRect the layer will report for getBoundingClientRect. */
function stubRect(svg: SVGSVGElement, rect: { width: number; height: number }): void {
  vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: rect.width,
    bottom: rect.height,
    width: rect.width,
    height: rect.height,
    x: 0,
    y: 0,
    toJSON: () => "",
  } as DOMRect);
}

describe("AnnotationLayer — pin tool", () => {
  it("adds a pin at normalized coordinates on click", () => {
    const onAdd = vi.fn<(a: Annotation) => void>();
    render(<Harness initial={[]} tool="pin" onAdd={onAdd} />);
    const svg = screen.getByTestId("annotation-layer") as unknown as SVGSVGElement;
    stubRect(svg, { width: 200, height: 100 });

    act(() => {
      fireEvent.pointerDown(svg, { clientX: 50, clientY: 25, pointerId: 1 });
    });

    expect(onAdd).toHaveBeenCalledTimes(1);
    const pin = onAdd.mock.calls[0]![0];
    expect(pin.kind).toBe("pin");
    expect(pin.x).toBeCloseTo(0.25, 3);
    expect(pin.y).toBeCloseTo(0.25, 3);
    expect(pin.order).toBe(1);
  });

  it("numbers pins sequentially", () => {
    const onAdd = vi.fn<(a: Annotation) => void>();
    render(<Harness initial={[]} tool="pin" onAdd={onAdd} />);
    const svg = screen.getByTestId("annotation-layer") as unknown as SVGSVGElement;
    stubRect(svg, { width: 100, height: 100 });

    act(() => {
      fireEvent.pointerDown(svg, { clientX: 10, clientY: 10, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerDown(svg, { clientX: 90, clientY: 90, pointerId: 1 });
    });

    expect(onAdd.mock.calls.map((c) => c[0].order)).toEqual([1, 2]);
  });
});

describe("AnnotationLayer — rect tool", () => {
  it("creates a rectangle via drag", () => {
    const onAdd = vi.fn<(a: Annotation) => void>();
    render(<Harness initial={[]} tool="rect" onAdd={onAdd} />);
    const svg = screen.getByTestId("annotation-layer") as unknown as SVGSVGElement;
    stubRect(svg, { width: 100, height: 100 });

    // Separate act() calls so React re-renders between events and the
    // pointer-move / pointer-up handlers see the updated dragRect state.
    // In production these events arrive from distinct native events so
    // the component always re-renders between them.
    act(() => {
      fireEvent.pointerDown(svg, { clientX: 20, clientY: 20, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerMove(svg, { clientX: 60, clientY: 50, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerUp(svg, { clientX: 60, clientY: 50, pointerId: 1 });
    });

    expect(onAdd).toHaveBeenCalledTimes(1);
    const rect = onAdd.mock.calls[0]![0];
    expect(rect.kind).toBe("rect");
    if (rect.kind === "rect") {
      expect(rect.x).toBeCloseTo(0.2, 3);
      expect(rect.y).toBeCloseTo(0.2, 3);
      expect(rect.w).toBeCloseTo(0.4, 3);
      expect(rect.h).toBeCloseTo(0.3, 3);
    }
  });

  it("ignores zero-area drags (treated as a click)", () => {
    const onAdd = vi.fn<(a: Annotation) => void>();
    render(<Harness initial={[]} tool="rect" onAdd={onAdd} />);
    const svg = screen.getByTestId("annotation-layer") as unknown as SVGSVGElement;
    stubRect(svg, { width: 100, height: 100 });

    act(() => {
      fireEvent.pointerDown(svg, { clientX: 20, clientY: 20, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerUp(svg, { clientX: 20, clientY: 20, pointerId: 1 });
    });

    expect(onAdd).not.toHaveBeenCalled();
  });
});

describe("AnnotationLayer — select tool", () => {
  it("clears selection on empty-space click", () => {
    const onSelect = vi.fn<(id: string | null) => void>();
    const seed: Annotation = {
      id: "p1",
      kind: "pin",
      x: 0.5,
      y: 0.5,
      note: "",
      color: "#f00",
      order: 1,
    };
    render(<Harness initial={[seed]} tool="select" onSelect={onSelect} />);
    const svg = screen.getByTestId("annotation-layer") as unknown as SVGSVGElement;
    stubRect(svg, { width: 100, height: 100 });

    act(() => {
      fireEvent.pointerDown(svg, { clientX: 10, clientY: 10, pointerId: 1 });
    });

    expect(onSelect).toHaveBeenCalledWith(null);
  });
});
