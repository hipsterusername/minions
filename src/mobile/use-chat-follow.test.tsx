import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useChatFollow } from "./use-chat-follow.ts";
import { ChatFollow } from "./ChatFollow.tsx";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function Feed({ activity = "first" }: { activity?: string }) {
  const follow = useChatFollow("session", activity);
  return <><div ref={follow.feedRef} onScroll={follow.onScroll} tabIndex={-1} data-testid="feed">Earlier message</div>
    {follow.hasNewActivity && <ChatFollow onResume={follow.resume} />}<input aria-label="Composer" /></>;
}
function dimensions(feed: HTMLElement) {
  Object.defineProperties(feed, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
}
it("pauses when scrolling up, preserves reading through tokens and focus, and resumes once", () => {
  const { rerender } = render(<Feed />);
  const feed = screen.getByTestId("feed"); dimensions(feed);
  feed.scrollTop = 300; fireEvent.scroll(feed);
  rerender(<Feed activity="token one" />);
  expect(feed.scrollTop).toBe(300);
  fireEvent.focus(screen.getByLabelText("Composer"));
  rerender(<Feed activity="token two" />);
  expect(feed.scrollTop).toBe(300);
  expect(screen.getAllByRole("button", { name: /New activity/ })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: /New activity/ }));
  expect(feed.scrollTop).toBe(1000);
  expect(document.activeElement).toBe(feed);
  expect(screen.queryByRole("button")).toBeNull();
  feed.scrollTop = 800;
  rerender(<Feed activity="token three" />);
  expect(feed.scrollTop).toBe(1000);
});
it("text selection pauses follow even near the bottom", () => {
  const { rerender } = render(<Feed />);
  const feed = screen.getByTestId("feed"); dimensions(feed);
  vi.spyOn(window, "getSelection").mockReturnValue({ isCollapsed: false, anchorNode: feed.firstChild } as Selection);
  feed.scrollTop = 800;
  rerender(<Feed activity="selected text streaming" />);
  expect(feed.scrollTop).toBe(800);
  expect(screen.getByRole("button", { name: /New activity/ })).toBeTruthy();
});
it("keeps a paused offset on keyboard/viewport resize and uses immediate scrolling with reduced motion", () => {
  let resize = () => {};
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const { rerender } = render(<Feed />);
  const feed = screen.getByTestId("feed"); dimensions(feed);
  const scrollTo = vi.fn(); feed.scrollTo = scrollTo;
  feed.scrollTop = 300; fireEvent.scroll(feed);
  feed.scrollTop = 250; act(() => resize());
  expect(feed.scrollTop).toBe(300);
  rerender(<Feed activity="new" />);
  fireEvent.click(screen.getByRole("button", { name: /New activity/ }));
  expect(feed.scrollTop).toBe(1000);
  expect(scrollTo).not.toHaveBeenCalled();
});
