/**
 * Component tests for DebugModeAffordance — the global toggle.
 *
 * Verifies:
 *   - the badge is hidden when debug mode is off,
 *   - Ctrl+Shift+D toggles the flag,
 *   - clicking the pill opens the feature-flags panel,
 *   - the panel's "Disable debug" button turns debug off.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isDebugEnabled, setDebugEnabled } from "../debug.ts";
import { DebugModeAffordance } from "./DebugModeAffordance.tsx";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  setDebugEnabled(false);
  window.localStorage.clear();
});

describe("DebugModeAffordance", () => {
  it("renders nothing when debug mode is disabled", () => {
    render(<DebugModeAffordance />);
    expect(screen.queryByText(/debug/i)).toBeNull();
  });

  it("shows the DEBUG pill when enabled", () => {
    setDebugEnabled(true);
    render(<DebugModeAffordance />);
    expect(screen.getByRole("button", { name: /open debug menu/i })).toBeInTheDocument();
  });

  it("Ctrl+Shift+D toggles the debug flag", () => {
    render(<DebugModeAffordance />);
    expect(isDebugEnabled()).toBe(false);
    fireEvent.keyDown(window, { key: "D", ctrlKey: true, shiftKey: true });
    expect(isDebugEnabled()).toBe(true);
    fireEvent.keyDown(window, { key: "D", ctrlKey: true, shiftKey: true });
    expect(isDebugEnabled()).toBe(false);
  });

  it("Cmd+Shift+D (mac) also toggles", () => {
    render(<DebugModeAffordance />);
    fireEvent.keyDown(window, { key: "d", metaKey: true, shiftKey: true });
    expect(isDebugEnabled()).toBe(true);
  });

  it("ignores plain Ctrl+D (browser bookmark)", () => {
    render(<DebugModeAffordance />);
    fireEvent.keyDown(window, { key: "d", ctrlKey: true });
    expect(isDebugEnabled()).toBe(false);
  });

  it("clicking the pill opens the feature-flags panel", () => {
    setDebugEnabled(true);
    render(<DebugModeAffordance />);
    expect(screen.queryByRole("dialog", { name: /feature flags/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /open debug menu/i }));
    expect(screen.getByRole("dialog", { name: /feature flags/i })).toBeInTheDocument();
    // Clicking again closes it.
    fireEvent.click(screen.getByRole("button", { name: /open debug menu/i }));
    expect(screen.queryByRole("dialog", { name: /feature flags/i })).toBeNull();
  });

  it("the panel's 'Disable debug' button turns debug mode off", () => {
    setDebugEnabled(true);
    render(<DebugModeAffordance />);
    fireEvent.click(screen.getByRole("button", { name: /open debug menu/i }));
    fireEvent.click(screen.getByRole("button", { name: /disable debug/i }));
    expect(isDebugEnabled()).toBe(false);
  });
});
