/**
 * Unit tests for the feature-flag store.
 *
 * Covers the public contract that the debug panel + every gating call
 * site relies on: defaults, persistence, override pruning, pub/sub, and
 * the `useSyncExternalStore` adapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FEATURE_FLAGS,
  featureFlagStore,
  getAllFeatureFlags,
  getFeatureFlag,
  resetFeatureFlags,
  setFeatureFlag,
  subscribeFeatureFlags,
} from "./feature-flags.ts";

const STORAGE_KEY = "minions:feature-flags";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("feature-flags registry", () => {
  it("ships with `routines` registered and OFF by default", () => {
    const def = FEATURE_FLAGS.find((d) => d.id === "routines");
    expect(def).toBeDefined();
    expect(def?.defaultValue).toBe(false);
    expect(getFeatureFlag("routines")).toBe(false);
  });

  it("returns false for unknown ids (fail-closed)", () => {
    expect(getFeatureFlag("not-a-real-flag")).toBe(false);
  });

  it("getAllFeatureFlags returns one entry per registered flag", () => {
    const all = getAllFeatureFlags();
    expect(Object.keys(all).sort()).toEqual(
      FEATURE_FLAGS.map((f) => f.id).sort(),
    );
  });
});

describe("setFeatureFlag", () => {
  it("persists overrides to localStorage", () => {
    setFeatureFlag("routines", true);
    expect(getFeatureFlag("routines")).toBe(true);
    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ routines: true });
  });

  it("removes the override (and clears storage when empty) on reset to default", () => {
    setFeatureFlag("routines", true);
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    setFeatureFlag("routines", false); // back to default
    expect(getFeatureFlag("routines")).toBe(false);
    // Storage blob should be gone, not "{}", to keep persistence tidy.
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("ignores unknown ids", () => {
    setFeatureFlag("not-a-real-flag", true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("does not notify when the value is unchanged", () => {
    const fn = vi.fn();
    const unsub = subscribeFeatureFlags(fn);
    setFeatureFlag("routines", false); // already default
    expect(fn).not.toHaveBeenCalled();
    setFeatureFlag("routines", true);
    expect(fn).toHaveBeenCalledTimes(1);
    setFeatureFlag("routines", true); // no-op
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
  });
});

describe("resetFeatureFlags", () => {
  it("drops every override and notifies subscribers", () => {
    setFeatureFlag("routines", true);
    const fn = vi.fn();
    const unsub = subscribeFeatureFlags(fn);
    resetFeatureFlags();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(getFeatureFlag("routines")).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
  });
});

describe("storage robustness", () => {
  it("ignores corrupt JSON and falls back to defaults", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(getFeatureFlag("routines")).toBe(false);
  });

  it("ignores non-boolean override values", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ routines: "yes please" }),
    );
    expect(getFeatureFlag("routines")).toBe(false);
  });

  it("ignores unknown ids in the persisted blob", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ "ghost-flag": true, routines: true }),
    );
    const all = getAllFeatureFlags();
    expect(all["routines"]).toBe(true);
    expect("ghost-flag" in all).toBe(false);
  });
});

describe("featureFlagStore (useSyncExternalStore adapter)", () => {
  it("snapshot reflects writes and subscribers fire on change", () => {
    const store = featureFlagStore("routines");
    expect(store.getSnapshot()).toBe(false);
    const fn = vi.fn();
    const unsub = store.subscribe(fn);
    setFeatureFlag("routines", true);
    expect(store.getSnapshot()).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("unsubscribe stops further notifications", () => {
    const fn = vi.fn();
    const unsub = featureFlagStore("routines").subscribe(fn);
    unsub();
    setFeatureFlag("routines", true);
    expect(fn).not.toHaveBeenCalled();
  });
});
