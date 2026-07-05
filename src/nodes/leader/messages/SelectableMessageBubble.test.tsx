/**
 * Regression test for the "click to select → copy" path failing in Firefox.
 *
 * Bug: `SelectableMessageBubble` had a local `copyText` that called
 * `navigator.clipboard.writeText` directly. In Firefox served over a
 * non-secure context, `navigator.clipboard` is `undefined`, so clicking a
 * copy button in selection mode threw and nothing was copied. The bubble now
 * routes through the shared, guarded `copyText` helper (execCommand fallback).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { SelectableMessageBubble } from "./SelectableMessageBubble.tsx";
import type { LeaderMessage, MessageContextSelection } from "../types.ts";

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
    setClipboard(undefined);
  }
  vi.restoreAllMocks();
});

const msg: LeaderMessage = {
  id: "m1",
  role: "assistant",
  content: "hello world",
  timestamp: 0,
};

const activeSelection: MessageContextSelection = {
  messageId: "m1",
  selectedChunkIds: [],
  anchorChunkId: null,
};

it("copies the full message via the fallback when navigator.clipboard is undefined", async () => {
  setClipboard(undefined);
  const exec = vi.fn().mockReturnValue(true);
  (document as unknown as { execCommand: unknown }).execCommand = exec;

  render(
    <SelectableMessageBubble
      msg={msg}
      selection={activeSelection}
      onActivate={() => {}}
      onSelectionChange={() => {}}
      onExit={() => {}}
    />,
  );

  // "Copy full message" is always enabled in selection mode.
  fireEvent.click(screen.getByRole("button", { name: "Copy full message" }));

  expect(exec).toHaveBeenCalledWith("copy");
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Copied"));
});
