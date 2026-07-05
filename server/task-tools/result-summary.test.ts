import { describe, expect, it } from "vitest";
import { capTaskTextForSummary, taskTextCharCount } from "./result-summary.ts";

describe("capTaskTextForSummary", () => {
  it("passes through under-cap text without a marker", () => {
    const text = "short result";

    expect(capTaskTextForSummary(text, 20, "result")).toBe(text);
    expect(capTaskTextForSummary(text, 20, "result")).not.toContain(
      "[truncated",
    );
  });

  it("truncates over-cap text with an accurate total count marker", () => {
    const text = "abcdef";

    expect(capTaskTextForSummary(text, 3, "description")).toBe(
      'abc…[truncated — 6 chars total; call get_task_status with detail:"full" for the complete description]',
    );
  });

  it("does not split surrogate pairs when truncating", () => {
    const text = "a😀b";
    const capped = capTaskTextForSummary(text, 2, "result");

    expect(taskTextCharCount(text)).toBe(3);
    expect(capped.startsWith("a😀…[truncated")).toBe(true);
    expect(Array.from(capped.split("…[truncated")[0]!)).toEqual(["a", "😀"]);
    expect(capped).not.toContain("\ufffd");
    expect(capped).toContain("3 chars total");
  });
});
