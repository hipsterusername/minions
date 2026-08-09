import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LeaderStatusIcon } from "./LeaderStatusIcon.tsx";

describe("LeaderStatusIcon", () => {
  it("exposes active and idle states to users", () => {
    const { rerender } = render(<LeaderStatusIcon active size={22} />);

    const activeIcon = screen.getByRole("img", { name: "Active" });
    expect(activeIcon).toHaveClass("leader-status-icon");
    expect(activeIcon).toHaveAttribute("data-state", "active");

    rerender(<LeaderStatusIcon active={false} size={18} />);
    const idleIcon = screen.getByRole("img", { name: "Idle" });
    expect(idleIcon).toHaveAttribute("data-state", "idle");
  });

  it("can be hidden from assistive technology when its container labels it", () => {
    const { container } = render(
      <LeaderStatusIcon active={false} size={20} decorative />,
    );

    expect(screen.queryByRole("img")).toBeNull();
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });
});
