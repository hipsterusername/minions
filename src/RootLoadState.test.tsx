import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { RootErrorBoundary, RootLoadingScreen } from "./RootLoadState.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("shows a visible status while the root bundle loads", () => {
  render(<RootLoadingScreen />);

  expect(screen.getByRole("status")).toHaveTextContent("Loading workspace…");
});

it("offers a full reload when the root app fails to render", () => {
  const reload = vi.fn();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("location", { ...window.location, reload });
  function BrokenApp(): never {
    throw new Error("chunk failed");
  }

  render(
    <RootErrorBoundary>
      <BrokenApp />
    </RootErrorBoundary>,
  );

  expect(screen.getByRole("alert")).toHaveTextContent("Minions couldn’t load");
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  expect(reload).toHaveBeenCalledOnce();
});
