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
  it("ships without any registered flags", () => {
    expect(FEATURE_FLAGS).toEqual([]);
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
  it("ignores unknown ids", () => {
    setFeatureFlag("not-a-real-flag", true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("does not notify when the value is unchanged", () => {
    const fn = vi.fn();
    const unsub = subscribeFeatureFlags(fn);
    setFeatureFlag("not-a-real-flag", true);
    expect(fn).not.toHaveBeenCalled();
    unsub();
  });
});

describe("resetFeatureFlags", () => {
  it("clears persisted overrides and notifies subscribers", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ stale: true }));
    const fn = vi.fn();
    const unsub = subscribeFeatureFlags(fn);
    resetFeatureFlags();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
  });
});

describe("storage robustness", () => {
  it("ignores corrupt JSON and falls back to defaults", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(getFeatureFlag("not-a-real-flag")).toBe(false);
  });

  it("ignores non-boolean override values", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ stale: "yes please" }),
    );
    expect(getAllFeatureFlags()).toEqual({});
  });

  it("ignores unknown ids in the persisted blob", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ "ghost-flag": true }),
    );
    const all = getAllFeatureFlags();
    expect("ghost-flag" in all).toBe(false);
  });
});

describe("featureFlagStore (useSyncExternalStore adapter)", () => {
  it("unknown flag snapshots stay false", () => {
    const store = featureFlagStore("not-a-real-flag");
    expect(store.getSnapshot()).toBe(false);
    const fn = vi.fn();
    const unsub = store.subscribe(fn);
    setFeatureFlag("not-a-real-flag", true);
    expect(store.getSnapshot()).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    unsub();
  });

  it("unsubscribe stops further notifications", () => {
    const fn = vi.fn();
    const unsub = featureFlagStore("not-a-real-flag").subscribe(fn);
    unsub();
    setFeatureFlag("not-a-real-flag", true);
    expect(fn).not.toHaveBeenCalled();
  });
});
