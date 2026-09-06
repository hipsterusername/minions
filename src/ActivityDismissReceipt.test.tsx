import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ActivityDismissReceipt, useActivityRemovalFocus } from "./ActivityDismissReceipt.tsx";
import { useActivityLifecycle } from "./use-activity-lifecycle.ts";
import type { SocketSubscribe } from "./use-socket.ts";
import type { MobileSessionInfo } from "./mobile/mobile-selectors.ts";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const first: MobileSessionInfo = { sessionKey: "one", sessionId: null, status: "idle", cwd: "/tmp", taskName: "First" };
const second = { ...first, sessionKey: "two", taskName: "Second" };
it("shows only confirmed bulk successes and restores once using the acknowledged revision", () => {
  let emit: (message: unknown) => void = () => {};
  const send = vi.fn();
  const subscribe = ((_key: string, handler: typeof emit) => { emit = handler; return () => {}; }) as SocketSubscribe;
  function Harness() {
    const controller = useActivityLifecycle({ socketSend: send, socketSubscribe: subscribe });
    return <><button onClick={() => { controller.sendLifecycle("dismiss", first); controller.sendLifecycle("dismiss", second); }}>Dismiss both</button>
      <ActivityDismissReceipt controller={controller} sessions={[first, second]} />
      <p>{controller.actionError}</p></>;
  }
  render(<Harness />);
  fireEvent.click(screen.getByText("Dismiss both"));
  expect(screen.queryByRole("status")).toBeNull();
  act(() => emit({ type: "control_response", command: "dismiss_session", requestId: send.mock.calls[0]![0].requestId, success: false, error: "Busy" }));
  act(() => emit({ type: "control_response", command: "dismiss_session", requestId: send.mock.calls[1]![0].requestId, success: true, lifecycle: { lifecycleRevision: 8, dismissedAt: 1 } }));
  expect(screen.getByText(/Dismissed from Activity · 1 activity/)).toBeVisible();
  expect(screen.getByText(/First: Dismiss failed: Busy/)).toBeVisible();
  const restore = screen.getByRole("button", { name: "Undo" });
  fireEvent.click(restore); fireEvent.click(restore);
  expect(send).toHaveBeenCalledTimes(3);
  expect(send.mock.calls[2]![0]).toMatchObject({ type: "reopen_session", sessionKey: "two", expectedLifecycleRevision: 8 });
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  act(() => emit({ type: "control_response", command: "reopen_session", requestId: send.mock.calls[2]![0].requestId, success: false, error: "Retry" }));
  expect(screen.getByRole("button", { name: "Undo" }).hasAttribute("disabled")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  act(() => emit({ type: "control_response", command: "reopen_session", requestId: send.mock.calls[3]![0].requestId, success: true }));
  expect(screen.queryByRole("status")).toBeNull();
});
it("expires eight seconds after the latest dismissal and supports closing early", () => {
  vi.useFakeTimers();
  let emit: (message: unknown) => void = () => {};
  const send = vi.fn();
  const subscribe = ((_key: string, handler: typeof emit) => { emit = handler; return () => {}; }) as SocketSubscribe;
  function Harness() {
    const controller = useActivityLifecycle({ socketSend: send, socketSubscribe: subscribe });
    return <><button onClick={() => controller.sendLifecycle("dismiss", first)}>Dismiss first</button>
      <button onClick={() => controller.sendLifecycle("dismiss", second)}>Dismiss second</button>
      <ActivityDismissReceipt controller={controller} sessions={[first, second]} /></>;
  }
  render(<Harness />);
  const dismiss = (name: string) => {
    fireEvent.click(screen.getByText(name));
    act(() => emit({ type: "control_response", command: "dismiss_session", requestId: send.mock.lastCall![0].requestId, success: true }));
  };
  dismiss("Dismiss first");
  act(() => vi.advanceTimersByTime(7_999));
  expect(screen.getByRole("status")).toBeVisible();
  dismiss("Dismiss second");
  act(() => vi.advanceTimersByTime(7_999));
  expect(screen.getByRole("status")).toHaveTextContent("2 activities");
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByRole("status")).toBeNull();
  dismiss("Dismiss first");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss activity notification" }));
  expect(screen.queryByRole("status")).toBeNull();
  dismiss("Dismiss second");
  expect(screen.getByRole("status")).toHaveTextContent("1 activity");
});

it("moves focus to a surviving row after removal without stealing focus elsewhere", () => {
  function List({ removed = false }: { removed?: boolean }) {
    const focus = useActivityRemovalFocus();
    return <div {...focus}>{!removed && <button>Dismiss first</button>}<button className="act-card-main">Second row</button></div>;
  }
  const { rerender } = render(<List />);
  act(() => screen.getByText("Dismiss first").focus());
  rerender(<List removed />);
  expect(document.activeElement).toBe(screen.getByText("Second row"));
});
