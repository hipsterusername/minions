import { describe, expect, it } from "vitest";

import {
  buildEmptyCanvasLeaderPrompt,
  isValidEmptyCanvasDescription,
} from "./empty-canvas.ts";

describe("isValidEmptyCanvasDescription", () => {
  it("requires a meaningful context description", () => {
    expect(isValidEmptyCanvasDescription("")).toBe(false);
    expect(isValidEmptyCanvasDescription("   short   ")).toBe(false);
    expect(isValidEmptyCanvasDescription("Build the onboarding dashboard.")).toBe(true);
  });
});

describe("buildEmptyCanvasLeaderPrompt", () => {
  it("wraps the description and requires dashboard setup and refresh", () => {
    const prompt = buildEmptyCanvasLeaderPrompt("  Line one\r\nLine two  ");

    expect(prompt).toContain("<context-description>\nLine one\nLine two\n</context-description>");
    expect(prompt).toContain("call render_set with a concise dashboard");
    expect(prompt).toContain("ask only for the missing context");
    expect(prompt).toContain("refresh the dashboard with render_set");
  });
});
