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

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
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

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
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

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
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

describe("DashboardSurface — prioritized questions", () => {
  const question = {
    id: "question",
    type: "form" as const,
    title: "Choose a direction",
    fields: [{ id: "direction", kind: "text" as const, label: "Direction", required: true }],
  };

  it("lifts questions to the start of the shared scroll area and renders each only once", () => {
    const { container } = render(
      <DashboardSurface renderState={{ ...makeState(), components: [...makeState().components, question] }} />,
    );
    const panel = screen.getByRole("region", { name: "Pending leader questions" });
    expect(panel).toContainElement(screen.getByRole("textbox", { name: "Direction" }));
    expect(screen.getAllByRole("textbox", { name: "Direction" })).toHaveLength(1);
    expect(container.querySelector(".rd-grid")).not.toContainElement(panel);
    expect(panel.parentElement).toHaveClass("rd-scroll");
    expect(panel.parentElement?.firstElementChild).toBe(panel);
    expect(panel.querySelector("[data-scroll-capture]")).toBeNull();
  });

  it("exposes questions in collapsed sections and inactive tabs without duplicating them", () => {
    const state: RenderState = {
      layout: {},
      components: [{
        id: "details", type: "section", title: "Details", components: [{
          id: "tabs", type: "tabs", activeTabId: "summary", tabs: [
            { id: "summary", label: "Summary", components: [{ id: "text", type: "text", content: "Background" }] },
            { id: "decision", label: "Decision", components: [question] },
          ],
        }],
      }],
    };
    render(<DashboardSurface renderState={state} />);
    expect(screen.getByRole("textbox", { name: "Direction" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /expand all dashboard sections/i }));
    expect(screen.getAllByRole("textbox", { name: "Direction" })).toHaveLength(1);
    expect(screen.getByText("Background")).toBeVisible();
  });

  it("validates a reply, sends it once, and moves the answered form into the dashboard", () => {
    const onSubmitForm = vi.fn();
    const { container, rerender } = render(
      <DashboardSurface renderState={{ layout: {}, components: [question] }} onSubmitForm={onSubmitForm} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmitForm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Direction is required");
    fireEvent.change(screen.getByRole("textbox", { name: "Direction" }), { target: { value: "Simple" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmitForm).toHaveBeenCalledExactlyOnceWith("question", { direction: "Simple" });
    expect(screen.getByText("Sending response…")).toBeInTheDocument();
    expect(screen.queryByText(/Response received/)).toBeNull();
    rerender(<DashboardSurface renderState={{ layout: {}, components: [{ ...question, submittedAnswers: { direction: "Simple" } }] }} onSubmitForm={onSubmitForm} />);
    expect(screen.queryByRole("region", { name: "Pending leader questions" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Direction" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Direction" })).toHaveValue("Simple");
    expect(container.querySelector(".rd-grid")).toContainElement(screen.getByRole("textbox", { name: "Direction" }));
  });

  it("selects the remaining tab when its active tab only contained a lifted question", () => {
    render(<DashboardSurface renderState={{ layout: {}, components: [{
      id: "tabs", type: "tabs", activeTabId: "decision", tabs: [
        { id: "decision", label: "Decision", components: [question] },
        { id: "summary", label: "Summary", components: [{ id: "background", type: "text", content: "Background" }] },
      ],
    }] }} />);
    expect(screen.getByRole("tab", { name: "Summary" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Background")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Direction" })).toBeVisible();
  });

  it("keeps drafts in other questions when one is answered, and clears removed forms", () => {
    const second = { ...question, id: "second", fields: [{ id: "notes", kind: "text" as const, label: "Notes" }] };
    const state: RenderState = { layout: {}, components: [question, second] };
    const { rerender } = render(<DashboardSurface renderState={state} onSubmitForm={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Keep this draft" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Direction" }), { target: { value: "Simple" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Submit" })[0]!);
    expect(screen.getByLabelText("Notes")).toHaveValue("Keep this draft");
    expect(screen.getByRole("region", { name: "Pending leader questions" })).toContainElement(screen.getByRole("textbox", { name: "Direction" }));
    rerender(<DashboardSurface renderState={{ layout: {}, components: [] }} />);
    rerender(<DashboardSurface renderState={{ layout: {}, components: [question] }} />);
    expect(screen.getByRole("textbox", { name: "Direction" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Direction" })).toHaveValue("");
  });

  it("keeps server-answered forms in the grid while promoting incoming questions with the header hidden", () => {
    const { rerender } = render(<DashboardSurface renderState={makeState()} hideHeader />);
    rerender(<DashboardSurface hideHeader renderState={{ layout: {}, components: [
      { ...question, submittedAnswers: { direction: "Already answered" } },
    ] }} />);
    expect(screen.queryByRole("region", { name: "Pending leader questions" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Direction" })).toHaveValue("Already answered");
    rerender(<DashboardSurface hideHeader renderState={{ layout: {}, components: [question] }} />);
    expect(screen.getByRole("region", { name: "Pending leader questions" })).toContainElement(screen.getByRole("textbox", { name: "Direction" }));
  });
});
