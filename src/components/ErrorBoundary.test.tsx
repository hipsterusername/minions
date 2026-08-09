import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary.tsx";

// A child component that unconditionally throws during render.
function AlwaysThrows(): never {
  throw new Error("boom from child");
}

// A child component that throws only when the `shouldThrow` prop is true.
function MaybeThrows({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("conditional boom");
  return <span>healthy child</span>;
}

describe("ErrorBoundary", () => {
  // Suppress the expected console.error output from React/error boundary
  // so test output stays clean.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders children normally when no error is thrown", () => {
    render(
      <ErrorBoundary>
        <span>all good</span>
      </ErrorBoundary>,
    );
    expect(screen.getByText("all good")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders fallback with error message when a child throws", () => {
    // Silence the jsdom console.error for this expected throw.
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <ErrorBoundary>
        <AlwaysThrows />
      </ErrorBoundary>,
    );

    // Fallback should be visible
    expect(screen.getByRole("alert")).toBeInTheDocument();
    // The error message from the throwing component should appear
    expect(screen.getByText(/boom from child/)).toBeInTheDocument();
    // A Retry button should be present
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("includes the optional label in the error heading", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <ErrorBoundary label="MetricWidget">
        <AlwaysThrows />
      </ErrorBoundary>,
    );

    expect(screen.getByText(/MetricWidget — render error/i)).toBeInTheDocument();
  });

  it("uses a generic heading when no label is given", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <ErrorBoundary>
        <AlwaysThrows />
      </ErrorBoundary>,
    );

    expect(screen.getByText(/Render error/i)).toBeInTheDocument();
  });

  it("resets and re-renders children after clicking Retry", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    // We'll swap shouldThrow from outside the boundary by re-rendering.
    // After reset the boundary clears its error state; the parent can then
    // pass fixed children.
    const { rerender } = render(
      <ErrorBoundary>
        <MaybeThrows shouldThrow={true} />
      </ErrorBoundary>,
    );

    // Boundary should be in error state
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // Re-render with non-throwing children then click Retry
    rerender(
      <ErrorBoundary>
        <MaybeThrows shouldThrow={false} />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("healthy child")).toBeInTheDocument();
  });
});
