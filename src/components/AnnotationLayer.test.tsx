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

describe("AnnotationLayer — selection works regardless of active tool", () => {
  // Standard create/edit model: clicking an existing mark always selects
  // it, no matter which create-tool (pin or rect) is currently active.
  // Dispatching by hit test removes the modal "Select" tool that used
  // to gate everything.
  const pin: Annotation = {
    id: "p1", kind: "pin", x: 0.5, y: 0.5, note: "", color: "#f00", order: 1,
  };
  const rect: Annotation = {
    id: "r1", kind: "rect", x: 0.2, y: 0.2, w: 0.3, h: 0.3, note: "", color: "#00f", order: 2,
  };

  it.each(["pin", "rect"] as const)(
    "clicking a pin selects it in %s tool",
    (tool) => {
      const onSelect = vi.fn<(id: string | null) => void>();
      const onAdd = vi.fn<(a: Annotation) => void>();
      render(<Harness initial={[pin]} tool={tool} onSelect={onSelect} onAdd={onAdd} />);
      const pinEl = screen.getByTestId(`pin-${pin.id}`);
      act(() => {
        fireEvent.pointerDown(pinEl, { clientX: 50, clientY: 50, pointerId: 1 });
      });
      expect(onSelect).toHaveBeenCalledWith(pin.id);
      expect(onAdd).not.toHaveBeenCalled();
    },
  );

  it.each(["pin", "rect"] as const)(
    "clicking a rect selects it in %s tool",
    (tool) => {
      const onSelect = vi.fn<(id: string | null) => void>();
      const onAdd = vi.fn<(a: Annotation) => void>();
      render(<Harness initial={[rect]} tool={tool} onSelect={onSelect} onAdd={onAdd} />);
      const rectEl = screen.getByTestId(`rect-${rect.id}`);
      act(() => {
        fireEvent.pointerDown(rectEl, { clientX: 30, clientY: 30, pointerId: 1 });
      });
      expect(onSelect).toHaveBeenCalledWith(rect.id);
      expect(onAdd).not.toHaveBeenCalled();
    },
  );
});

describe("AnnotationLayer — rect move and resize", () => {
  const rect: Annotation = {
    id: "r1", kind: "rect", x: 0.2, y: 0.2, w: 0.4, h: 0.4, note: "", color: "#00f", order: 1,
  };

  // The create/edit model means a rect must be moveable and resizable
  // under EITHER active tool — there is no separate "Select" tool to
  // switch to. We parameterise these tests over both tools so the
  // contract is exercised explicitly.
  it.each(["pin", "rect"] as const)(
    "drags a rect by its body when %s tool is active",
    (tool) => {
      const onUpdate = vi.fn<(id: string, patch: Partial<Annotation>) => void>();
      render(<Harness initial={[rect]} tool={tool} onUpdate={onUpdate} />);
      const svg = screen.getByTestId("annotation-layer") as unknown as SVGSVGElement;
      stubRect(svg, { width: 100, height: 100 });
      const rectEl = screen.getByTestId(`rect-${rect.id}`);

      // Grab at normalized (0.3, 0.3) — offset from top-left is (0.1, 0.1).
      act(() => {
        fireEvent.pointerDown(rectEl, { clientX: 30, clientY: 30, pointerId: 1 });
      });
      act(() => {
        fireEvent.pointerMove(svg, { clientX: 50, clientY: 50, pointerId: 1 });
      });
      act(() => {
        fireEvent.pointerUp(svg, { clientX: 50, clientY: 50, pointerId: 1 });
      });

      // Expected new top-left = pointer(0.5, 0.5) - offset(0.1, 0.1) = (0.4, 0.4).
      const moveCall = onUpdate.mock.calls.find(
        (c) => c[0] === rect.id && c[1].x !== undefined,
      );
      expect(moveCall).not.toBeUndefined();
      expect(moveCall![1].x).toBeCloseTo(0.4, 3);
      expect(moveCall![1].y).toBeCloseTo(0.4, 3);
    },
  );

  it.each(["pin", "rect"] as const)(
    "resizes from the SE handle when %s tool is active",
    (tool) => {
      const onUpdate = vi.fn<(id: string, patch: Partial<Annotation>) => void>();
      // Rect is selected so the handles render.
      render(<Harness initial={[rect]} tool={tool} onUpdate={onUpdate} />);
      // Click the rect first to establish selection in the harness.
      const rectEl = screen.getByTestId(`rect-${rect.id}`);
      act(() => {
        fireEvent.pointerDown(rectEl, { clientX: 40, clientY: 40, pointerId: 1 });
      });
      act(() => {
        fireEvent.pointerUp(rectEl, { clientX: 40, clientY: 40, pointerId: 1 });
      });

      const svg = screen.getByTestId("annotation-layer") as unknown as SVGSVGElement;
      stubRect(svg, { width: 100, height: 100 });
      const seHandle = screen.getByTestId(`rect-handle-${rect.id}-se`);
      act(() => {
        fireEvent.pointerDown(seHandle, { clientX: 60, clientY: 60, pointerId: 2 });
      });
      act(() => {
        fireEvent.pointerMove(svg, { clientX: 90, clientY: 90, pointerId: 2 });
      });
      act(() => {
        fireEvent.pointerUp(svg, { clientX: 90, clientY: 90, pointerId: 2 });
      });

      // Width/height grow to pointer - origin = 0.9 - 0.2 = 0.7 (top-left anchored).
      const resize = onUpdate.mock.calls.find(
        (c) => c[0] === rect.id && (c[1] as Partial<{ w: number }>).w !== undefined,
      );
      expect(resize).not.toBeUndefined();
      const patch = resize![1] as Partial<{ x: number; y: number; w: number; h: number }>;
      expect(patch.x).toBeCloseTo(0.2, 3);
      expect(patch.y).toBeCloseTo(0.2, 3);
      expect(patch.w).toBeCloseTo(0.7, 3);
      expect(patch.h).toBeCloseTo(0.7, 3);
    },
  );
});

describe("AnnotationLayer — aspect-aware rendering", () => {
  /**
   * Pins must stay round on non-square images. The previous implementation
   * used `viewBox="0 0 100 100"` with `preserveAspectRatio="none"`, which
   * stretched circles into ovals when the host content box wasn't 1:1.
   * The fix: viewBox aspect matches the host's `aspectRatio` prop and
   * `preserveAspectRatio` is allowed to default (uniform scaling).
   */
  it("matches viewBox aspect ratio to the aspectRatio prop (no preserveAspectRatio=none)", () => {
    render(
      <div style={{ width: 400, height: 200, position: "relative" }}>
        <AnnotationLayer
          annotations={[]}
          tool="pin"
          defaultColor="#3b82f6"
          selectedId={null}
          onSelect={() => {}}
          onAdd={() => {}}
          onUpdate={() => {}}
          aspectRatio={2}
        />
      </div>,
    );
    const svg = screen.getByTestId("annotation-layer");
    // 2:1 aspect → viewBox "0 0 200 100".
    expect(svg.getAttribute("viewBox")).toBe("0 0 200 100");
    // The non-uniform scaling escape hatch must be gone.
    expect(svg.getAttribute("preserveAspectRatio")).toBeNull();
  });

  it("defaults to a 1:1 viewBox when no aspectRatio is supplied", () => {
    render(
      <div style={{ width: 200, height: 200, position: "relative" }}>
        <AnnotationLayer
          annotations={[]}
          tool="pin"
          defaultColor="#3b82f6"
          selectedId={null}
          onSelect={() => {}}
          onAdd={() => {}}
          onUpdate={() => {}}
        />
      </div>,
    );
    const svg = screen.getByTestId("annotation-layer");
    expect(svg.getAttribute("viewBox")).toBe("0 0 100 100");
  });
});

describe("AnnotationLayer — order stability", () => {
  it("new marks pick up max(order) + 1, not length + 1", () => {
    // After deletes, orders may be sparse (e.g. 1, 5, 7). A new addition
    // must not collide with any existing value — deriving from the max
    // is the only way to guarantee that without a global counter.
    const sparse: Annotation[] = [
      { id: "a1", kind: "pin", x: 0.1, y: 0.1, note: "", color: "#000", order: 1 },
      { id: "a2", kind: "pin", x: 0.2, y: 0.2, note: "", color: "#000", order: 5 },
      { id: "a3", kind: "pin", x: 0.3, y: 0.3, note: "", color: "#000", order: 7 },
    ];
    const onAdd = vi.fn<(a: Annotation) => void>();
    render(<Harness initial={sparse} tool="pin" onAdd={onAdd} />);
    const svg = screen.getByTestId("annotation-layer") as unknown as SVGSVGElement;
    stubRect(svg, { width: 100, height: 100 });

    act(() => {
      fireEvent.pointerDown(svg, { clientX: 60, clientY: 60, pointerId: 1 });
    });

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0]![0].order).toBe(8);
  });
});
