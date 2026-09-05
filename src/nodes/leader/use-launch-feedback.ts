import { useEffect, useRef, useState, type RefObject } from "react";
import type { LeaderData } from "./types.ts";

/** A transport enqueue is not a launch. Wait for authoritative run/session state. */
export function useLaunchFeedback(data: LeaderData, target: RefObject<HTMLElement | null>,
  onStarted?: (prompt: string) => void, onFailed?: () => void) {
  const claimed = useRef(false);
  const submitted = useRef("");
  const [state, setState] = useState<"ready" | "pending" | "started" | "unconfirmed">("ready");
  function begin(prompt: string) {
    if (claimed.current) return false;
    claimed.current = true;
    submitted.current = prompt;
    setState("pending");
    return true;
  }
  function failed(uncertain = false) {
    claimed.current = uncertain;
    setState(uncertain ? "unconfirmed" : "ready");
  }
  useEffect(() => {
    if (state === "started" && !data.sessionKey && !data.workItemSnapshot) {
      claimed.current = false; setState("ready"); return;
    }
    if (!claimed.current || state === "started") return;
    const item = data.workItemSnapshot;
    const started = item ? Boolean(item.currentRunKey)
      && (item.lifecycle.runtimeState === "starting" || item.lifecycle.runtimeState === "working")
      : Boolean(data.sessionKey) && (data.status === "running" || data.status === "idle");
    if (started) {
      setState("started");
      onStarted?.(submitted.current);
      target.current?.focus({ preventScroll: true });
    } else if (!item && data.status === "error") {
      claimed.current = false;
      setState("ready");
      onFailed?.();
    }
  }, [data.sessionKey, data.status, data.workItemSnapshot, state, target, onStarted, onFailed]);
  return { begin, failed, pending: state === "pending" || state === "unconfirmed",
    notice: state === "started" ? "Leader started" : state === "unconfirmed"
      ? "Launch not confirmed. Waiting for server state; do not launch again." : null };
}
