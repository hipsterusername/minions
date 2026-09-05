import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionChangesPanel } from "./ChangesView.tsx";
import { LEADER_DEFAULT_DATA } from "./nodes/leader/types.ts";
import type { SocketSubscribe } from "./use-socket.ts";

function setup() {
  const listeners = new Set<(message: unknown) => void>();
  const subscribe = Object.assign(((_topic: string, fn: (message: unknown) => void) => {
    listeners.add(fn); return () => { listeners.delete(fn); };
  }) as SocketSubscribe, { supportsTopics: true as const });
  const send = vi.fn();
  render(<SessionChangesPanel nodeId="n" sessionKey="s" data={{ ...LEADER_DEFAULT_DATA,
    sessionKey: "s", worktreeIsolation: true, worktreeStatus: "active" }}
    socketSend={send} socketSubscribe={subscribe} onUpdateNodeData={vi.fn()} onOpenInCanvas={vi.fn()} />);
  const latest = () => send.mock.calls.filter(([message]) => message.type === "get_worktree_diff").at(-1)![0].requestId;
  const reply = (requestId: string, extra: object) => act(() => {
    for (const fn of listeners) fn({ type: "control_response", command: "get_worktree_diff", sessionKey: "s", requestId, ...extra });
  });
  return { latest, reply };
}
const diff = (file: string) => ({ filesChanged: 1, insertions: 2, deletions: 0, commits: [], files: [{ file, status: "added", insertions: 2, deletions: 0 }] });

describe("diff receipts", () => {
  it("reports initial failure and retries with a fresh correlated request", () => {
    const { latest, reply } = setup();
    const first = latest();
    reply(first, { success: false, error: "Cannot read worktree" });
    expect(screen.getByRole("alert")).toHaveTextContent("Cannot read worktree");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(latest()).not.toBe(first);
    reply(latest(), { success: true, diff: diff("fixed.ts") });
    expect(screen.getByText("fixed.ts")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("retains diff DOM and scroll during refresh/failure, and ignores reversed responses", () => {
    const { latest, reply } = setup();
    reply(latest(), { success: true, diff: diff("original.ts") });
    const files = screen.getByText("original.ts").closest(".changes-card__files")!;
    files.scrollTop = 32;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    const old = latest();
    expect(screen.getByText("Refreshing…")).toBeVisible();
    expect(screen.getByText("original.ts").closest(".changes-card__files")).toBe(files);
    expect(files.scrollTop).toBe(32);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    reply(latest(), { success: false, error: "Temporary failure" });
    expect(screen.getByText("original.ts")).toBeVisible();
    expect(screen.getByText(/Last loaded/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    reply(latest(), { success: true, diff: diff("newest.ts") });
    reply(old, { success: true, diff: diff("obsolete.ts") });
    expect(screen.getByText("newest.ts")).toBeVisible();
    expect(screen.queryByText("obsolete.ts")).toBeNull();
  });
  it("times out honestly and ignores a late response after retry", () => {
    vi.useFakeTimers();
    try {
      const { latest, reply } = setup();
      const old = latest();
      act(() => vi.advanceTimersByTime(15000));
      expect(screen.getByRole("alert")).toHaveTextContent("Still waiting for changes");
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      reply(old, { success: true, diff: diff("late.ts") });
      expect(screen.queryByText("late.ts")).toBeNull();
      reply(latest(), { success: true, diff: diff("current.ts") });
      expect(screen.getByText("current.ts")).toBeVisible();
    } finally { vi.useRealTimers(); }
  });

});
