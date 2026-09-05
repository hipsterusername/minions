import { useLayoutEffect, useRef, useState } from "react";

/** Streaming may move the feed only while the reader is following live. */
export function useChatFollow(sessionKey: string, activity: unknown, active = true) {
  const feedRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [hasNewActivity, setHasNewActivity] = useState(false);
  const position = useRef(0);
  const previous = useRef(activity);

  useLayoutEffect(() => {
    following.current = true;
    position.current = 0;
    setHasNewActivity(false);
  }, [sessionKey]);

  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (!feed || !active) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && feed.contains(selection.anchorNode)) following.current = false;
    if (following.current) {
      feed.scrollTop = feed.scrollHeight;
      position.current = feed.scrollTop;
    } else if (previous.current !== activity) {
      setHasNewActivity(true);
    }
    previous.current = activity;
  }, [activity, active, sessionKey]);

  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (!feed || !active) return;
    // Keyboard/viewport resizing preserves the reader's offset; it is not new activity.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      if (!following.current) feed.scrollTop = position.current;
    });
    observer?.observe(feed);
    return () => observer?.disconnect();
  }, [active]);

  function onScroll() {
    const feed = feedRef.current;
    if (!feed) return;
    position.current = feed.scrollTop;
    following.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    if (following.current) setHasNewActivity(false);
  }

  function resume() {
    const feed = feedRef.current;
    if (!feed) return;
    following.current = true;
    // Immediate scrolling avoids token-by-token animations and honors reduced motion.
    feed.scrollTop = feed.scrollHeight;
    position.current = feed.scrollTop;
    setHasNewActivity(false);
    feed.focus({ preventScroll: true });
  }
  return { feedRef, onScroll, resume, hasNewActivity };
}
