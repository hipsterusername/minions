/**
 * Regression tests for the copy button failing in Firefox.
 *
 * Bug: `CopyButton` called `navigator.clipboard.writeText` unconditionally.
 * In Firefox served over a non-secure context (e.g. a plain-http LAN address),
 * `navigator.clipboard` is `undefined`, so the click threw synchronously and
 * nothing was copied — no fallback, no feedback.
 *
 * The fix routes copying through `copyText`, which guards the async Clipboard
 * API and falls back to `document.execCommand("copy")`.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CopyButton, copyText } from "./CopyButton.tsx";

const originalClipboard = Object.getOwnPropertyDescriptor(
  globalThis.navigator,
  "clipboard",
);

function setClipboard(value: unknown): void {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (originalClipboard) {
    Object.defineProperty(globalThis.navigator, "clipboard", originalClipboard);
  } else {
    // jsdom has no clipboard by default; remove whatever the test set.
    setClipboard(undefined);
  }
  vi.restoreAllMocks();
});

describe("copyText", () => {
  it("uses the async Clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    await copyText("hello");

    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand when navigator.clipboard is undefined", async () => {
    setClipboard(undefined);
    const exec = vi.fn().mockReturnValue(true);
    // execCommand does not exist in jsdom by default.
    (document as unknown as { execCommand: unknown }).execCommand = exec;

    await copyText("fallback text");

    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("rejects when both the Clipboard API and execCommand fail", async () => {
    setClipboard(undefined);
    (document as unknown as { execCommand: unknown }).execCommand = vi
      .fn()
      .mockReturnValue(false);

    await expect(copyText("x")).rejects.toThrow();
  });
});

describe("CopyButton", () => {
  it("copies via the fallback and shows the copied state (Firefox non-secure context)", async () => {
    setClipboard(undefined);
    const exec = vi.fn().mockReturnValue(true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;

    render(<CopyButton text="copy me" alwaysVisible />);

    fireEvent.click(screen.getByRole("button"));

    expect(exec).toHaveBeenCalledWith("copy");
    // The button flips to the "copied" title once the copy resolves.
    await waitFor(() =>
      expect(screen.getByRole("button")).toHaveAttribute(
        "title",
        expect.stringMatching(/copy/i),
      ),
    );
  });

  it("does not throw when copying fails entirely", async () => {
    setClipboard(undefined);
    (document as unknown as { execCommand: unknown }).execCommand = vi
      .fn()
      .mockReturnValue(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(<CopyButton text="copy me" alwaysVisible />);
    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(warn).toHaveBeenCalled());
  });
});
