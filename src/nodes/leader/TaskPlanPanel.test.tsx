import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskPlanPanel } from "./TaskPlanPanel.tsx";
import type { TaskPlanItem } from "./types.ts";

function item(taskId: string, status: TaskPlanItem["status"]): TaskPlanItem {
  return {
    taskId,
    title: taskId,
    description: "",
    priority: "medium",
    executor: "minion",
    minionSessionKey: `minion-${taskId}`,
    status,
    createdAt: 1,
    completedAt: null,
    result: null,
    cost: 0,
    sessionSummary: "",
  };
}

describe("TaskPlanPanel", () => {
  it("renders a JSON summary and supporting fields in the result tooltip", () => {
    render(<TaskPlanPanel taskPlan={[{ ...item("audit", "completed"),
      result: JSON.stringify({ summary: "Audit finished", tests: ["Build passed"] }) }]}
      expanded onToggle={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByText("audit"));
    expect(screen.getByText("Audit finished")).toBeInTheDocument();
    expect(screen.getByText("Build passed")).toBeInTheDocument();
  });

  it("reports successful and unsuccessful terminal outcomes separately", () => {
    render(
      <TaskPlanPanel
        taskPlan={[
          item("done", "completed"),
          item("failed", "failed"),
          item("cancelled", "cancelled"),
          item("active", "running"),
        ]}
        expanded={false}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByText(/1 succeeded · 2 unsuccessful · 4 total/)).toBeInTheDocument();
    expect(screen.getByText("1 running")).toBeInTheDocument();
  });
});
