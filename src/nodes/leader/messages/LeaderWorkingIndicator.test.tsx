import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LeaderWorkingIndicator } from "./LeaderWorkingIndicator.tsx";

describe("LeaderWorkingIndicator", () => {
  it("renders a compact saccade eye without the dashboard pulse ring", () => {
    render(<LeaderWorkingIndicator />);

    expect(screen.getByLabelText("Leader is working")).toHaveTextContent("working");
    const pupil = screen.getByTestId("leader-working-pupil");
    expect(pupil.className).toContain("rd-pupil--");
    expect(pupil.parentElement?.classList.contains("rd-pulse-ring")).toBe(false);
    expect(document.querySelector(".rd-pulse-ring")).toBeNull();
  });
});
