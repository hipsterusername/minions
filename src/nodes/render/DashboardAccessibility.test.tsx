import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DashboardSurface } from "./DashboardSurface.tsx";
import { RenderComponentView } from "../RenderNode.tsx";
import { MobileDashboardPanel } from "../../mobile/SessionChatScreen.tsx";
import type { RenderComponent, RenderState } from "../../../shared/render-dsl.ts";

const section: RenderComponent = {
  id: "details", type: "section", title: "Details", defaultOpen: true,
  components: [{ id: "copy", type: "copyable", content: "pnpm test" }],
};
const state: RenderState = { layout: {}, components: [section] };

it("shows the focused selection marker and names the selected component", () => {
  const css = readFileSync("src/index.css", "utf8");
  const style = document.createElement("style");
  style.textContent = css.slice(css.indexOf(".render-context-selectable {"), css.indexOf("/* ── Canvas text-selection:"));
  document.head.appendChild(style);
  try {
    render(<DashboardSurface renderState={state} />);
    expect(screen.queryByRole("button", { name: "Add component to context selection: Details" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    const marker = screen.getByTitle("Add component to context selection");
    marker.focus();
    expect(getComputedStyle(marker).opacity).toBe("1");
    expect(marker).toHaveAccessibleName("Add component to context selection: Details");
    expect(screen.getByRole("button", { name: "Done selecting" })).toBeVisible();
    fireEvent.click(marker);
    expect(marker).toHaveAttribute("aria-pressed", "true");
  } finally { style.remove(); }
});

it("keeps nested keyboard and SVG button interactions independent of card selection", () => {
  render(<DashboardSurface renderState={state} />);
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  fireEvent.click(screen.getByRole("button", { name: "Add component to context selection: Details" }));
  const card = screen.getByTestId("render-context-component");
  expect(card).not.toHaveAttribute("role", "checkbox");
  const copy = screen.getByRole("button", { name: "Copy to clipboard" });
  for (const key of [" ", "Enter"]) {
    expect(fireEvent.keyDown(copy, { key, bubbles: true, cancelable: true })).toBe(true);
    expect(card).toHaveAttribute("data-selected", "true");
  }
  // SVG descendants must be recognized as belonging to the copy button.
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  screen.getByRole("button", { name: "Details" }).appendChild(svg);
  fireEvent.click(svg);
  expect(card).toHaveAttribute("data-selected", "true");
});

it("namespaces repeated form fields across forms and mounted hosts without changing answer keys", () => {
  const onSubmit = vi.fn();
  const forms: RenderComponent[] = ["a", "b"].map(id => ({
    id, type: "form", title: id, fields: [{ id: "name", kind: "text", label: `Name ${id}`, required: true, description: `Help ${id}` }],
  }));
  render(<><DashboardSurface renderState={{ layout: {}, components: forms }} onSubmitForm={onSubmit} />
    <DashboardSurface renderState={{ layout: {}, components: forms }} /></>);
  const inputs = screen.getAllByRole("textbox");
  expect(new Set(inputs.map(input => input.id)).size).toBe(4);
  for (const input of inputs) {
    const label = document.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`);
    expect(label?.control).toBe(input);
    const form = input.closest("form")!;
    fireEvent.submit(form);
    for (const id of input.getAttribute("aria-describedby")!.split(" ")) {
      expect(form).toContainElement(document.getElementById(id));
    }
  }
  fireEvent.change(inputs[1]!, { target: { value: "Approved" } });
  fireEvent.submit(inputs[1]!.closest("form")!);
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith("b", { name: "Approved" });
});

it("uses roving tab focus and unique tab/panel associations across instances", () => {
  const tabs: RenderComponent = { id: "tabs", type: "tabs", tabs: [
    { id: "a", label: "Summary", components: [{ id: "text", type: "text", content: "Hello" }] },
    { id: "b", label: "Details", components: [] },
  ] };
  const view = render(<><RenderComponentView component={tabs} /><RenderComponentView component={tabs} /></>);
  const lists = screen.getAllByRole("tablist");
  const buttons = within(lists[0]!).getAllByRole("tab");
  expect(buttons.map(tab => tab.tabIndex)).toEqual([0, -1]);
  fireEvent.keyDown(buttons[0]!, { key: "End" });
  expect(document.activeElement).toBe(buttons[1]);
  expect(buttons.map(tab => tab.tabIndex)).toEqual([-1, 0]);
  const panel = document.getElementById(buttons[1]!.getAttribute("aria-controls")!);
  expect(panel).toHaveAttribute("aria-labelledby", buttons[1]!.id);
  expect(panel).toHaveAccessibleName("Details");
  expect(panel).not.toHaveAttribute("hidden");
  expect(new Set(screen.getAllByRole("tab").map(tab => tab.id)).size).toBe(4);
  view.rerender(<><RenderComponentView component={{ ...tabs, tabs: tabs.tabs.map(tab => ({ ...tab, badge: "Updated" })) }} /><RenderComponentView component={tabs} /></>);
  expect(document.activeElement).toBe(buttons[1]);
  fireEvent.keyDown(buttons[1]!, { key: "Home" });
  expect(document.activeElement).toBe(buttons[0]);
});

it("exposes progress values and exact chart data with an accessible chart name", () => {
  render(<><RenderComponentView component={{ id: "p", type: "progress", label: "Checks", value: 75 }} />
    <RenderComponentView component={{ id: "c", type: "chart", title: "Trend", series: [{ label: "Completed", data: [{ x: "Mon", y: 10 }, { x: "Tue", y: 20 }] }], xAxis: { type: "category" } }} /></>);
  expect(screen.getByRole("progressbar", { name: "Checks" })).toHaveAttribute("aria-valuenow", "75");
  expect(screen.getByRole("img", { name: "Trend" })).toHaveAccessibleDescription(/exact values/i);
  fireEvent.click(screen.getByText("View chart data"));
  const table = screen.getByRole("table", { name: "Trend — exact values" });
  expect(within(table).getAllByRole("row")).toHaveLength(3);
  expect(within(table).getByRole("cell", { name: "20" })).toBeInTheDocument();
});

it("reapplies explicit expand/collapse commands after local toggles", () => {
  render(<DashboardSurface renderState={state} />);
  const toggle = screen.getByRole("button", { name: "Details" });
  const expand = screen.getByRole("button", { name: "Expand all dashboard sections" });
  const collapse = screen.getByRole("button", { name: "Collapse all dashboard sections" });
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(collapse);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(toggle);
  fireEvent.click(collapse);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(expand);
  fireEvent.click(toggle);
  fireEvent.click(expand);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
});

it("promotes and submits a mobile question from a collapsed section in an inactive tab", () => {
  const send = vi.fn();
  const renderState: RenderState = { layout: {}, components: [{ id: "s", type: "section", title: "Review", components: [
    { id: "tabs", type: "tabs", tabs: [
      { id: "overview", label: "Overview", components: [{ id: "text", type: "text", content: "Context" }] },
      { id: "question", label: "Question", components: [{ id: "q", type: "form", title: "Choose direction", fields: [{ id: "answer", kind: "text", label: "Answer" }] }] },
    ] },
  ] }] };
  render(<MobileDashboardPanel renderState={renderState} sessionKey="session" send={send} />);
  const input = screen.getByRole("textbox", { name: "Answer" });
  expect(screen.getByRole("region", { name: "Pending leader questions" })).toContainElement(input);
  expect(screen.getByRole("button", { name: "1 pending question" })).toBeVisible();
  fireEvent.change(input, { target: { value: "Proceed" } });
  fireEvent.submit(input.closest("form")!);
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: "submit_form", sessionKey: "session", formComponentId: "q", formAnswers: { answer: "Proceed" } });
});
