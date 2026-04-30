/**
 * Component tests for DebugModeAffordance — the global toggle.
 *
 * Verifies:
 *   - the badge is hidden when debug mode is off,
 *   - Ctrl+Shift+D toggles the flag,
 *   - clicking the badge disables debug mode.
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
});

describe("DebugModeAffordance", () => {
  it("renders nothing when debug mode is disabled", () => {
    render(<DebugModeAffordance />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the DEBUG pill when enabled", () => {
    setDebugEnabled(true);
    render(<DebugModeAffordance />);
    expect(screen.getByRole("button", { name: /debug/i })).toBeInTheDocument();
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

  it("clicking the pill disables debug mode", () => {
    setDebugEnabled(true);
    render(<DebugModeAffordance />);
    const btn = screen.getByRole("button", { name: /debug/i });
    fireEvent.click(btn);
    expect(isDebugEnabled()).toBe(false);
  });
});
