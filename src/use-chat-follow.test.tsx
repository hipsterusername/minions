import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useChatFollow } from "./use-chat-follow.ts";
import { JumpToLatest } from "./components/JumpToLatest.tsx";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function Feed({ session = "one", activity = "initial", active = true }) {
  const follow = useChatFollow(session, activity, active);
  return <><div ref={follow.feedRef} onScroll={follow.onScroll} tabIndex={0} data-testid="feed">
    <div ref={follow.contentRef} data-testid="content">{activity}</div>
  </div>{!follow.isFollowing && <JumpToLatest onClick={follow.resume} hasNewActivity={follow.hasNewActivity} />}</>;
}

function geometry() {
  const dimensions = { height: 200, content: 1000 };
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => dimensions.height);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => dimensions.content);
  let resize = () => {};
  const observe = vi.fn(); const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  return { dimensions, resize: () => act(() => resize()), observe, disconnect };
}

it("starts at the end, follows delayed content growth, and resets for another session", () => {
  const { dimensions, resize, observe, disconnect } = geometry();
  const { rerender, unmount } = render(<Feed />);
  const feed = screen.getByTestId("feed");
  expect(feed.scrollTop).toBe(1000);
  expect(observe).toHaveBeenCalledWith(screen.getByTestId("content"));
  dimensions.content = 1600; resize();
  expect(feed.scrollTop).toBe(1600);
  feed.scrollTop = 120; fireEvent.scroll(feed);
  expect(screen.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  rerender(<Feed session="two" />);
  expect(feed.scrollTop).toBe(1600);
  expect(screen.queryByRole("button")).toBeNull();
  unmount(); expect(disconnect).toHaveBeenCalled();
});

it("preserves a paused reading offset while hidden and restores it when shown", () => {
  const { dimensions, resize } = geometry();
  const { rerender } = render(<Feed />);
  const feed = screen.getByTestId("feed");
  feed.scrollTop = 120; fireEvent.scroll(feed);
  dimensions.height = 0; feed.scrollTop = 0; fireEvent.scroll(feed); resize();
  rerender(<Feed active={false} activity="hidden update" />);
  dimensions.height = 300;
  rerender(<Feed activity="visible update" />);
  expect(feed.scrollTop).toBe(120);
  expect(screen.getByRole("button", { name: /New activity/ })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Jump to latest/ }));
  expect(feed.scrollTop).toBe(1000);
  expect(feed).toHaveFocus();
});

it("pins to the latest output after a hidden tab receives messages", () => {
  const { dimensions, resize } = geometry();
  const { rerender } = render(<Feed />);
  const feed = screen.getByTestId("feed");
  dimensions.height = 0; feed.scrollTop = 0; fireEvent.scroll(feed);
  rerender(<Feed active={false} activity="hidden update" />);
  dimensions.content = 1800; dimensions.height = 200;
  rerender(<Feed activity="hidden update" />); resize();
  expect(feed.scrollTop).toBe(1800);
  expect(screen.queryByRole("button")).toBeNull();
});

it("keeps following when reflow dispatches scroll before the resize observer", () => {
  const { dimensions, resize } = geometry();
  render(<Feed />);
  const feed = screen.getByTestId("feed");
  dimensions.content = 2000;
  dimensions.height = 300;
  fireEvent.scroll(feed);
  resize();
  expect(feed.scrollTop).toBe(2000);
  expect(screen.queryByRole("button")).toBeNull();
  feed.scrollTop = 120;
  fireEvent.scroll(feed);
  expect(screen.getByRole("button", { name: "Jump to latest" })).toBeVisible();
});
