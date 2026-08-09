import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_THEME_ID } from "./themes.ts";
import { loadPersistedThemeId } from "./use-theme.ts";

describe("persisted theme selection", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("restores a theme that still exists", () => {
    window.localStorage.setItem("canvas-theme", "daybook");
    expect(loadPersistedThemeId()).toBe("daybook");
  });

  it.each(["glass", "nocturne"])("falls back when removed theme %s was persisted", (id) => {
    window.localStorage.setItem("canvas-theme", id);
    expect(loadPersistedThemeId()).toBe(DEFAULT_THEME_ID);
  });
});
