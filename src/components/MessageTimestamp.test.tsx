import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  formatMessageTimestamp,
  MessageTimestamp,
} from "./MessageTimestamp.tsx";

describe("MessageTimestamp", () => {
  it("renders a machine-readable time with a compact visible label", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T16:00:00.000Z"));
    const timestamp = new Date("2026-07-29T15:42:00.000Z").getTime();

    const { container } = render(<MessageTimestamp timestamp={timestamp} />);
    const time = container.querySelector("time");

    expect(time).toHaveAttribute("datetime", "2026-07-29T15:42:00.000Z");
    expect(time).toHaveAttribute("title");
    expect(time?.textContent).not.toBe("");
    vi.useRealTimers();
  });

  it("adds calendar context to messages from another day", () => {
    const timestamp = new Date("2025-12-14T15:42:00.000Z").getTime();
    const now = new Date("2026-07-29T16:00:00.000Z").getTime();

    const formatted = formatMessageTimestamp(timestamp, now);

    expect(formatted?.label).toMatch(/2025/);
  });

  it("does not render missing or invalid event times", () => {
    const { container, rerender } = render(<MessageTimestamp timestamp={0} />);
    expect(container.querySelector("time")).toBeNull();

    rerender(<MessageTimestamp timestamp={Number.NaN} />);
    expect(container.querySelector("time")).toBeNull();
  });
});
