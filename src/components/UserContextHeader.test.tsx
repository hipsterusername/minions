import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { UserContextHeader } from "./UserContextHeader.tsx";

describe("UserContextHeader", () => {
  it("renders the literal label 'Context'", () => {
    render(<UserContextHeader />);
    expect(screen.getByText("Context")).toBeInTheDocument();
  });

  it("uses the theme accent for the label color", () => {
    render(<UserContextHeader />);
    const node = screen.getByText("Context");
    expect(node.style.color).toBe("var(--accent)");
  });

  it("is non-selectable so it doesn't get included when copying the message body", () => {
    render(<UserContextHeader />);
    const node = screen.getByText("Context");
    expect(node.style.userSelect).toBe("none");
  });
});
