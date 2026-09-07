import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Follow live output until the reader scrolls away or selects transcript text. */
export function useChatFollow(sessionKey: string, activity: unknown, active = true) {
  const feedRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const position = useRef(0);
  const geometry = useRef({ height: 0, content: 0, width: 0 });
  const previous = useRef(activity);
  const [isFollowing, setIsFollowing] = useState(true);
  const [hasNewActivity, setHasNewActivity] = useState(false);

  const syncPosition = useCallback(() => {
    const feed = feedRef.current;
    // Hidden tabs have zero geometry; don't overwrite their reading position.
    if (!feed || !active || feed.clientHeight === 0) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && feed.contains(selection.anchorNode)) {
      if (following.current) position.current = feed.scrollTop;
      following.current = false;
      setIsFollowing(false);
    }
    feed.scrollTop = following.current ? feed.scrollHeight : position.current;
    position.current = feed.scrollTop;
    geometry.current = { height: feed.clientHeight, content: feed.scrollHeight, width: feed.clientWidth };
  }, [active]);

  useLayoutEffect(() => {
    following.current = true;
    position.current = 0;
    previous.current = activity;
    setIsFollowing(true);
    setHasNewActivity(false);
    // Activity intentionally isn't a reset dependency: streaming must not repin.
  }, [sessionKey]);

  useLayoutEffect(() => {
    if (!active) return;
    syncPosition();
    if (!following.current && previous.current !== activity) setHasNewActivity(true);
    previous.current = activity;
  }, [activity, active, sessionKey, syncPosition]);

  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (!feed || !active) return;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(syncPosition);
    observer?.observe(feed);
    // Images, expanded tools and delayed history can grow without a new message.
    if (contentRef.current) observer?.observe(contentRef.current);
    return () => observer?.disconnect();
  }, [active, syncPosition]);

  function onScroll() {
    const feed = feedRef.current;
    if (!feed || !active || feed.clientHeight === 0) return;
    // Layout can dispatch scroll before ResizeObserver, especially when text
    // reflows at a breakpoint. Preserve the reader's intent through that event.
    if (geometry.current.height !== feed.clientHeight
      || geometry.current.content !== feed.scrollHeight
      || geometry.current.width !== feed.clientWidth) {
      syncPosition();
      return;
    }
    position.current = feed.scrollTop;
    following.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    setIsFollowing(following.current);
    if (following.current) setHasNewActivity(false);
  }

  function resume() {
    const feed = feedRef.current;
    if (!feed) return;
    following.current = true;
    // Immediate scrolling honors reduced motion and avoids streaming races.
    feed.scrollTop = feed.scrollHeight;
    position.current = feed.scrollTop;
    setIsFollowing(true);
    setHasNewActivity(false);
    feed.focus({ preventScroll: true });
  }

  return { feedRef, contentRef, onScroll, resume, isFollowing, hasNewActivity };
}
