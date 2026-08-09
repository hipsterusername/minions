import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DashboardSurface } from "./DashboardSurface.tsx";
import type { RenderState } from "../../../shared/render-dsl.ts";

function makeState(): RenderState {
  return {
    layout: { title: "Build Dashboard", columns: 2, gap: 12 },
    components: [
      {
        id: "metric-1",
        type: "metric",
        label: "Open issues",
        value: "12",
        detail: "3 critical",
      },
      {
        id: "table-1",
        type: "table",
        title: "Files",
        headers: ["Path", "Status"],
        rows: [["src/app.ts", "changed"]],
        span: "full",
      },
    ],
  };
}

describe("DashboardSurface — context selection", () => {
  it("copies selected component context using component-aware formatting", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<DashboardSurface renderState={makeState()} />);

    fireEvent.click(screen.getAllByTitle("Add component to context selection")[0]!);
    fireEvent.click(screen.getByTitle("Copy selected dashboard context"));

    expect(writeText).toHaveBeenCalledWith("**Open issues**: 12 — 3 critical");
  });

  it("adds selected dashboard context as a markdown node", () => {
    const onAddContentNode = vi.fn();

    render(<DashboardSurface renderState={makeState()} onAddContentNode={onAddContentNode} />);

    fireEvent.click(screen.getAllByTitle("Add component to context selection")[1]!);
    fireEvent.click(screen.getByTitle("Add selected dashboard context as node"));

    expect(onAddContentNode).toHaveBeenCalledWith(
      [
        "### Files",
        "| Path | Status |",
        "| --- | --- |",
        "| src/app.ts | changed |",
      ].join("\n"),
    );
  });

  it("shows a 'Copied' indicator after copying selected context", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<DashboardSurface renderState={makeState()} />);

    fireEvent.click(screen.getAllByTitle("Add component to context selection")[0]!);
    expect(screen.queryByTestId("render-context-copied")).toBeNull();

    fireEvent.click(screen.getByTitle("Copy selected dashboard context"));

    const copied = await screen.findByTestId("render-context-copied");
    expect(copied).toHaveTextContent("Copied");
  });

  it("copies the full dashboard context from selection mode", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<DashboardSurface renderState={makeState()} />);

    fireEvent.click(screen.getAllByTitle("Add component to context selection")[0]!);
    fireEvent.click(screen.getByTitle("Copy full dashboard context"));

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("# Build Dashboard"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("| src/app.ts | changed |"));
  });
});

describe("DashboardSurface — states", () => {
  it("renders the empty state when there are no components", () => {
    render(<DashboardSurface renderState={{ layout: {}, components: [] }} />);
    expect(screen.getByText(/waiting for dashboard data/i)).toBeInTheDocument();
  });

  it("renders a payload error banner when payloadError is set", () => {
    render(
      <DashboardSurface
        renderState={makeState()}
        payloadError="Invalid render payload: bad action"
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(alert.textContent).toMatch(/invalid render payload/i);
  });

  it("defaults dashboard sections collapsed and toggles expand/collapse all", () => {
    const state: RenderState = {
      layout: { columns: 2, gap: 12 },
      components: [
        {
          id: "section-1",
          type: "section",
          title: "Findings",
          components: [{ id: "summary", type: "text", content: "Nested summary" }],
        },
      ],
    };

    render(<DashboardSurface renderState={state} />);

    expect(screen.getByText("Findings")).toBeInTheDocument();
    expect(screen.queryByText("Nested summary")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /expand all dashboard sections/i }));
    expect(screen.getByText("Nested summary")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /collapse all dashboard sections/i }));
    expect(screen.queryByText("Nested summary")).not.toBeInTheDocument();
  });

  it("forwards form submissions to onSubmitForm", () => {
    const onSubmitForm = vi.fn();
    const state: RenderState = {
      layout: {},
      components: [
        {
          id: "form-1",
          type: "form",
          title: "Pick one",
          fields: [{ id: "choice", kind: "text", label: "Choice" }],
        },
      ],
    };

    render(<DashboardSurface renderState={state} onSubmitForm={onSubmitForm} />);
    // The form renders a submit button; submitting posts answers back.
    const submit = screen.getByRole("button", { name: /submit/i });
    fireEvent.click(submit);
    expect(onSubmitForm).toHaveBeenCalledWith("form-1", expect.any(Object));
  });
});
