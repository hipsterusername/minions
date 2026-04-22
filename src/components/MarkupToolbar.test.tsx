/**
 * MarkupToolbar — tool picker, color palette, note editor, delete.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MarkupToolbar, MARKUP_PALETTE } from "./MarkupToolbar.tsx";
import type { Annotation } from "./AnnotationLayer.tsx";

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

describe("MarkupToolbar", () => {
  it("fires onToolChange when a tool is clicked", () => {
    const onToolChange = vi.fn();
    render(
      <MarkupToolbar
        tool="select"
        color={MARKUP_PALETTE[0]!.color}
        selected={null}
        annotationCount={0}
        onToolChange={onToolChange}
        onColorChange={() => {}}
        onNoteChange={() => {}}
        onDelete={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText("Pin"));
    expect(onToolChange).toHaveBeenCalledWith("pin");
    fireEvent.click(screen.getByLabelText("Rect"));
    expect(onToolChange).toHaveBeenCalledWith("rect");
  });

  it("marks the active tool pressed", () => {
    render(
      <MarkupToolbar
        tool="rect"
        color={MARKUP_PALETTE[0]!.color}
        selected={null}
        annotationCount={0}
        onToolChange={() => {}}
        onColorChange={() => {}}
        onNoteChange={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.getByLabelText("Rect").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("Pin").getAttribute("aria-pressed")).toBe("false");
  });

  it("fires onColorChange with a palette color", () => {
    const onColorChange = vi.fn();
    render(
      <MarkupToolbar
        tool="pin"
        color={MARKUP_PALETTE[0]!.color}
        selected={null}
        annotationCount={0}
        onToolChange={() => {}}
        onColorChange={onColorChange}
        onNoteChange={() => {}}
        onDelete={() => {}}
      />,
    );
    const second = MARKUP_PALETTE[1]!;
    fireEvent.click(screen.getByLabelText(second.label));
    expect(onColorChange).toHaveBeenCalledWith(second.color);
  });

  it("shows an annotation count summary", () => {
    const { rerender } = render(
      <MarkupToolbar
        tool="select"
        color={MARKUP_PALETTE[0]!.color}
        selected={null}
        annotationCount={0}
        onToolChange={() => {}}
        onColorChange={() => {}}
        onNoteChange={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.queryByText("no marks")).not.toBeNull();

    rerender(
      <MarkupToolbar
        tool="select"
        color={MARKUP_PALETTE[0]!.color}
        selected={null}
        annotationCount={1}
        onToolChange={() => {}}
        onColorChange={() => {}}
        onNoteChange={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.queryByText("1 mark")).not.toBeNull();

    rerender(
      <MarkupToolbar
        tool="select"
        color={MARKUP_PALETTE[0]!.color}
        selected={null}
        annotationCount={4}
        onToolChange={() => {}}
        onColorChange={() => {}}
        onNoteChange={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.queryByText("4 marks")).not.toBeNull();
  });

  it("renders a note editor and delete button when an annotation is selected", () => {
    const onNoteChange = vi.fn();
    const onDelete = vi.fn();
    const pin = basePin({ note: "hi" });
    render(
      <MarkupToolbar
        tool="select"
        color={pin.color}
        selected={pin}
        annotationCount={1}
        onToolChange={() => {}}
        onColorChange={() => {}}
        onNoteChange={onNoteChange}
        onDelete={onDelete}
      />,
    );
    const input = screen.getByLabelText("Annotation note") as HTMLInputElement;
    expect(input.value).toBe("hi");
    fireEvent.change(input, { target: { value: "fix spacing" } });
    expect(onNoteChange).toHaveBeenCalledWith(pin.id, "fix spacing");
    fireEvent.click(screen.getByLabelText("Delete annotation"));
    expect(onDelete).toHaveBeenCalledWith(pin.id);
  });
});
