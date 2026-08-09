/**
 * AnnotationList — roster of annotations with selection + delete.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AnnotationList } from "./AnnotationList.tsx";
import type { Annotation } from "./AnnotationLayer.tsx";

function pin(id: string, order: number, note = "", color = "#000"): Annotation {
  return { id, kind: "pin", x: 0.1, y: 0.1, note, color, order };
}
function rect(id: string, order: number, note = "", color = "#000"): Annotation {
  return { id, kind: "rect", x: 0.1, y: 0.1, w: 0.2, h: 0.2, note, color, order };
}

describe("AnnotationList", () => {
  it("returns nothing when there are no annotations", () => {
    const { container } = render(
      <AnnotationList
        annotations={[]}
        selectedId={null}
        onSelect={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders rows sorted by order, not array position", () => {
    render(
      <AnnotationList
        annotations={[pin("a", 3, "three"), pin("b", 1, "one"), pin("c", 2, "two")]}
        selectedId={null}
        onSelect={() => {}}
        onDelete={() => {}}
      />,
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "annotation-row-b",
      "annotation-row-c",
      "annotation-row-a",
    ]);
  });

  it("shows a placeholder label for marks without a note", () => {
    render(
      <AnnotationList
        annotations={[pin("p1", 1, ""), rect("r1", 2, "")]}
        selectedId={null}
        onSelect={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.queryByText("(unnamed pin)")).not.toBeNull();
    expect(screen.queryByText("(unnamed rect)")).not.toBeNull();
  });

  it("fires onSelect when a row is clicked", () => {
    const onSelect = vi.fn<(id: string) => void>();
    render(
      <AnnotationList
        annotations={[pin("p1", 1), pin("p2", 2)]}
        selectedId={null}
        onSelect={onSelect}
        onDelete={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("annotation-row-p2"));
    expect(onSelect).toHaveBeenCalledWith("p2");
  });

  it("fires onDelete from the per-row × button without also selecting", () => {
    const onSelect = vi.fn<(id: string) => void>();
    const onDelete = vi.fn<(id: string) => void>();
    render(
      <AnnotationList
        annotations={[pin("p1", 1)]}
        selectedId={null}
        onSelect={onSelect}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByLabelText("Delete pin 1"));
    expect(onDelete).toHaveBeenCalledWith("p1");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("marks the selected row aria-selected", () => {
    render(
      <AnnotationList
        annotations={[pin("p1", 1), pin("p2", 2)]}
        selectedId="p2"
        onSelect={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(
      screen.getByTestId("annotation-row-p2").getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByTestId("annotation-row-p1").getAttribute("aria-selected"),
    ).toBe("false");
  });

  it("Enter on a focused row selects; Delete key deletes", () => {
    const onSelect = vi.fn<(id: string) => void>();
    const onDelete = vi.fn<(id: string) => void>();
    render(
      <AnnotationList
        annotations={[pin("p1", 1)]}
        selectedId={null}
        onSelect={onSelect}
        onDelete={onDelete}
      />,
    );
    const row = screen.getByTestId("annotation-row-p1");
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("p1");
    fireEvent.keyDown(row, { key: "Delete" });
    expect(onDelete).toHaveBeenCalledWith("p1");
  });
});
