import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { UserContextHeader } from "./UserContextHeader.tsx";

describe("UserContextHeader", () => {
  it("renders the Context label with the theme accent and excludes it from copied text", () => {
    render(<UserContextHeader />);
    const node = screen.getByText("Context");
    expect(node).toBeInTheDocument();
    expect(node.style.color).toBe("var(--accent)");
    expect(node.style.userSelect).toBe("none");
  });
});
