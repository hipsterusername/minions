/**
 * Component tests for FeatureFlagsPanel — the debug-mode flag toggle.
 *
 * Verifies the contract:
 *   - the registered flags are listed,
 *   - toggling a checkbox writes through to the store,
 *   - "Reset to defaults" wipes overrides,
 *   - "Disable debug" calls back to the parent,
 *   - Escape and outside-clicks close the panel.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FEATURE_FLAGS,
  FLAG_MCP_SERVERS,
  getFeatureFlag,
} from "../feature-flags.ts";
import { FeatureFlagsPanel } from "./FeatureFlagsPanel.tsx";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("FeatureFlagsPanel", () => {
  it("does not offer a workspace toggle even with a stale override", () => {
    localStorage.setItem("minions:feature-flags", JSON.stringify({ "canvas-zones": false }));
    render(<FeatureFlagsPanel onClose={() => {}} onDisableDebug={() => {}} />);
    expect(screen.queryByLabelText(/canvas workspaces/i)).toBeNull();
  });

  it("renders one row per registered flag", () => {
    render(<FeatureFlagsPanel onClose={() => {}} onDisableDebug={() => {}} />);
    for (const def of FEATURE_FLAGS) {
      expect(screen.getByLabelText(new RegExp(def.label, "i"))).toBeInTheDocument();
    }
  });

  it("renders one checkbox per registered flag, reflecting defaults", () => {
    render(<FeatureFlagsPanel onClose={() => {}} onDisableDebug={() => {}} />);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(FEATURE_FLAGS.length);
    // mcp-servers ships off, so its row starts unchecked.
    const mcp = screen.getByLabelText(/mcp servers/i);
    expect(mcp).not.toBeChecked();
  });

  it("toggling a flag writes through to the store", () => {
    render(<FeatureFlagsPanel onClose={() => {}} onDisableDebug={() => {}} />);
    fireEvent.click(screen.getByLabelText(/mcp servers/i));
    expect(getFeatureFlag(FLAG_MCP_SERVERS)).toBe(true);
    expect(screen.getByLabelText(/mcp servers/i)).toBeChecked();
  });

  it("Reset to defaults restores flags to their defaults", () => {
    render(<FeatureFlagsPanel onClose={() => {}} onDisableDebug={() => {}} />);
    fireEvent.click(screen.getByLabelText(/mcp servers/i));
    expect(getFeatureFlag(FLAG_MCP_SERVERS)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /reset to defaults/i }));
    expect(getFeatureFlag(FLAG_MCP_SERVERS)).toBe(false);
    expect(screen.getByLabelText(/mcp servers/i)).not.toBeChecked();
  });

  it("Disable debug button calls the prop", () => {
    const onDisableDebug = vi.fn();
    render(<FeatureFlagsPanel onClose={() => {}} onDisableDebug={onDisableDebug} />);
    fireEvent.click(screen.getByRole("button", { name: /disable debug/i }));
    expect(onDisableDebug).toHaveBeenCalledTimes(1);
  });

  it("Escape calls onClose", () => {
    const onClose = vi.fn();
    render(<FeatureFlagsPanel onClose={onClose} onDisableDebug={() => {}} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking outside the panel calls onClose", () => {
    const onClose = vi.fn();
    render(
      <div>
        <div data-testid="outside" style={{ width: 10, height: 10 }} />
        <FeatureFlagsPanel onClose={onClose} onDisableDebug={() => {}} />
      </div>,
    );
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("× button calls onClose", () => {
    const onClose = vi.fn();
    render(<FeatureFlagsPanel onClose={onClose} onDisableDebug={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
