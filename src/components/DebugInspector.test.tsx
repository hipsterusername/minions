/**
 * Component tests for DebugInspector.
 *
 * Verifies user-visible behaviour:
 *   - duplicates are flagged when two assistant bubbles share content,
 *   - the recorder list updates when new records are pushed (via
 *     useSyncExternalStore),
 *   - the legitimate assistant→result collapse is NOT flagged.
 *
 * No snapshots — we query by data-attribute and visible text.
 */

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearDebugRecords,
  recordDebug,
  setDebugEnabled,
} from "../debug.ts";
import { DebugInspector } from "./DebugInspector.tsx";

const SESSION = "ses-inspector-test";

beforeEach(() => {
  window.localStorage.clear();
  clearDebugRecords(SESSION);
  setDebugEnabled(true); // recorder needs the flag on
});

afterEach(() => {
  setDebugEnabled(false);
});

describe("DebugInspector", () => {
  it("renders streaming buffer state", () => {
    render(
      <DebugInspector
        sessionKey={SESSION}
        streamingText="Hello"
        streamingBlockIndex={2}
        messages={[]}
      />,
    );
    expect(screen.getByText(/streamingText:/i)).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument(); // text length
    expect(screen.getByText("2")).toBeInTheDocument(); // block index
  });

  it("does NOT flag the legitimate assistant→result collapse", () => {
    render(
      <DebugInspector
        sessionKey={SESSION}
        streamingText=""
        streamingBlockIndex={null}
        messages={[
          { id: "a1", role: "assistant", content: "All done." },
          { id: "r1", role: "result", content: "All done." },
        ]}
      />,
    );
    expect(screen.queryByText(/Duplicate content detected/i)).toBeNull();
  });

  it("flags two assistant bubbles with identical content", () => {
    render(
      <DebugInspector
        sessionKey={SESSION}
        streamingText=""
        streamingBlockIndex={null}
        messages={[
          { id: "a1", role: "assistant", content: "Hello" },
          { id: "a2", role: "assistant", content: "Hello" },
        ]}
      />,
    );
    expect(screen.getByText(/Duplicate content detected/i)).toBeInTheDocument();
    expect(screen.getByText(/roles: assistant, assistant/i)).toBeInTheDocument();
  });

  it("renders recorder entries in newest-first order", () => {
    render(
      <DebugInspector
        sessionKey={SESSION}
        streamingText=""
        streamingBlockIndex={null}
        messages={[]}
      />,
    );
    act(() => {
      recordDebug(SESSION, { source: "ws", type: "sdk_event", sdkType: "assistant" });
      recordDebug(SESSION, { source: "ws", type: "sdk_event", sdkType: "result" });
    });
    const panel = screen.getByText(/Recent events/i).parentElement!;
    const entries = panel.querySelectorAll('[style*="border-bottom"]');
    expect(entries.length).toBe(2);
    // Newest-first: result then assistant.
    expect(entries[0]?.textContent).toMatch(/result/);
    expect(entries[1]?.textContent).toMatch(/assistant/);
  });
});
