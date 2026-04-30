/**
 * AnnotationSidebar — tool row, palette, note editor, list, Clear.
 *
 * Behavioural contract:
 *   • Tool buttons surface aria-pressed, fire onToolChange.
 *   • Palette aria-checked mirrors the *selected* mark's colour when a
 *     mark is selected; falls back to the prop `color` (default) otherwise.
 *   • A textarea is used for notes (multi-line), auto-focuses on a
 *     selection change, and fires onNoteChange on input.
 *   • List renders when annotations exist; empty-state copy otherwise.
 *   • Clear All is two-click: first click arms, second fires, disarms on
 *     annotation-count change.
 *   • Width stays fixed so the image area never gets squeezed.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AnnotationSidebar } from "./AnnotationSidebar.tsx";
import type { Annotation } from "./AnnotationLayer.tsx";
import { MARKUP_PALETTE } from "./markup-palette.ts";

function basePin(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "p1",
    kind: "pin",
    x: 0.1,
    y: 0.1,
    note: "",
    color: MARKUP_PALETTE[0]!.color,
    order: 1,
    ...overrides,
  } as Annotation;
}

type Props = Parameters<typeof AnnotationSidebar>[0];

function renderSidebar(overrides: Partial<Props> = {}) {
  const props: Props = {
    tool: "pin",
    color: MARKUP_PALETTE[0]!.color,
    selected: null,
    annotations: [],
    onToolChange: () => {},
    onColorChange: () => {},
    onNoteChange: () => {},
    onSelect: () => {},
    onDelete: () => {},
    ...overrides,
  };
  return render(<AnnotationSidebar {...props} />);
}

describe("AnnotationSidebar — tools", () => {
  it("fires onToolChange for each tool button", () => {
    const onToolChange = vi.fn();
    renderSidebar({ onToolChange });
    fireEvent.click(screen.getByLabelText("Pin"));
    fireEvent.click(screen.getByLabelText("Rect"));
    expect(onToolChange).toHaveBeenCalledWith("pin");
    expect(onToolChange).toHaveBeenCalledWith("rect");
  });

  it("marks the active tool with aria-pressed", () => {
    renderSidebar({ tool: "rect" });
    expect(screen.getByLabelText("Rect").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("Pin").getAttribute("aria-pressed")).toBe("false");
  });

  it("offers only Pin and Rect — no separate Select tool", () => {
    // The old three-tool model forced users to switch to Select before
    // they could move/resize a mark. The new model edits in place under
    // any tool, so the Select button is gone.
    renderSidebar();
    expect(screen.queryByLabelText("Select")).toBeNull();
    expect(screen.queryByLabelText("Pin")).not.toBeNull();
    expect(screen.queryByLabelText("Rect")).not.toBeNull();
  });
});

describe("AnnotationSidebar — palette", () => {
  it("fires onColorChange with the swatch color", () => {
    const onColorChange = vi.fn();
    renderSidebar({ onColorChange });
    const amber = MARKUP_PALETTE.find((s) => s.label === "Amber")!;
    fireEvent.click(screen.getByLabelText(amber.label));
    expect(onColorChange).toHaveBeenCalledWith(amber.color);
  });

  it("aria-checked reflects the selected mark's colour when a mark is selected", () => {
    const red = "#ef4444";
    renderSidebar({
      selected: basePin({ color: red }),
      annotations: [basePin({ color: red })],
      // default color intentionally different so we know the radio keys off selection
      color: MARKUP_PALETTE[0]!.color,
    });
    expect(screen.getByLabelText("Red").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByLabelText("Accent").getAttribute("aria-checked")).toBe("false");
  });

  it("aria-checked falls back to prop color when nothing is selected", () => {
    renderSidebar({ color: "#ef4444" });
    expect(screen.getByLabelText("Red").getAttribute("aria-checked")).toBe("true");
  });
});

describe("AnnotationSidebar — note editor", () => {
  it("is hidden when nothing is selected", () => {
    renderSidebar();
    expect(screen.queryByLabelText("Annotation note")).toBeNull();
  });

  it("renders a textarea and fires onNoteChange on input", () => {
    const onNoteChange = vi.fn();
    const pin = basePin({ note: "initial" });
    renderSidebar({ selected: pin, annotations: [pin], onNoteChange });
    const ta = screen.getByLabelText("Annotation note") as HTMLTextAreaElement;
    expect(ta.tagName.toLowerCase()).toBe("textarea");
    expect(ta.value).toBe("initial");
    fireEvent.change(ta, { target: { value: "updated" } });
    expect(onNoteChange).toHaveBeenCalledWith(pin.id, "updated");
  });

  it("auto-focuses the textarea on mount with a selection", () => {
    const pin = basePin({ note: "x" });
    renderSidebar({ selected: pin, annotations: [pin] });
    expect(document.activeElement).toBe(screen.getByLabelText("Annotation note"));
  });

  it("delete button fires onDelete for the selected mark", () => {
    const onDelete = vi.fn();
    const pin = basePin();
    renderSidebar({ selected: pin, annotations: [pin], onDelete });
    fireEvent.click(screen.getByLabelText("Delete annotation"));
    expect(onDelete).toHaveBeenCalledWith(pin.id);
  });
});

describe("AnnotationSidebar — list integration", () => {
  it("shows empty-state copy when there are no annotations", () => {
    renderSidebar();
    expect(screen.queryByTestId("annotation-list-empty")).not.toBeNull();
  });

  it("embeds AnnotationList and wires click-through selection", () => {
    const onSelect = vi.fn();
    const anns = [basePin({ id: "p1", order: 1 }), basePin({ id: "p2", order: 2 })];
    renderSidebar({ annotations: anns, onSelect });
    fireEvent.click(screen.getByTestId("annotation-row-p2"));
    expect(onSelect).toHaveBeenCalledWith("p2");
  });
});

describe("AnnotationSidebar — footer", () => {
  it("shows count summary (none / 1 / many)", () => {
    const { rerender } = renderSidebar();
    expect(screen.queryByText(/no marks/i)).not.toBeNull();

    rerender(
      <AnnotationSidebar
        tool="pin"
        color={MARKUP_PALETTE[0]!.color}
        selected={null}
        annotations={[basePin()]}
        onToolChange={() => {}}
        onColorChange={() => {}}
        onNoteChange={() => {}}
        onSelect={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.queryByText("1 mark")).not.toBeNull();

    const many = [
      basePin({ id: "a", order: 1 }),
      basePin({ id: "b", order: 2 }),
      basePin({ id: "c", order: 3 }),
    ];
    rerender(
      <AnnotationSidebar
        tool="pin"
        color={MARKUP_PALETTE[0]!.color}
        selected={null}
        annotations={many}
        onToolChange={() => {}}
        onColorChange={() => {}}
        onNoteChange={() => {}}
        onSelect={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.queryByText("3 marks")).not.toBeNull();
  });

  it("Clear All requires two clicks and fires only on the second", () => {
    const onClearAll = vi.fn();
    renderSidebar({
      annotations: [basePin(), basePin({ id: "p2", order: 2 })],
      onClearAll,
    });
    const btn = screen.getByLabelText(/^clear all annotations$/i);
    fireEvent.click(btn);
    expect(onClearAll).not.toHaveBeenCalled();
    const armed = screen.getByLabelText(/confirm clear all annotations/i);
    fireEvent.click(armed);
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });

  it("omits the Clear button entirely when there are no marks", () => {
    renderSidebar();
    expect(screen.queryByLabelText(/clear all annotations/i)).toBeNull();
  });
});

// Removed `AnnotationSidebar — layout contract` describe (§5.5 IMPL_COUPLING):
// both tests asserted on inline style strings (`flex: 0 0 Npx`, `width: Npx`)
// or on the presence of the `data-no-drag` attribute. Neither verifies the
// user-observable behaviour. The drag-propagation contract belongs in a
// Wave 2 behaviour test that drives the canvas drag layer end-to-end.
