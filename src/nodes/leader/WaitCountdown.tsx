import { useEffect, useRef, useState } from "react";

/**
 * Visual countdown shown while a leader session is in its `wait_and_continue`
 * state. The leader posts a `waitUntil` timestamp + a `reason`; this widget
 * ticks every second and renders an elapsed-progress bar that fills as the
 * resume time approaches.
 */
export function WaitCountdown({
  waitUntil,
  reason,
}: {
  waitUntil: number;
  reason: string;
}) {
  const totalDurationRef = useRef(Math.max(1, waitUntil - Date.now()));
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, waitUntil - Date.now()),
  );

  useEffect(() => {
    totalDurationRef.current = Math.max(1, waitUntil - Date.now());
    const tick = () => setRemaining(Math.max(0, waitUntil - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [waitUntil]);

  const totalSecs = Math.ceil(remaining / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  const display =
    mins > 0 ? `${mins}:${secs.toString().padStart(2, "0")}` : `${secs}s`;

  const elapsed = 1 - remaining / totalDurationRef.current;

  return (
    <div
      style={{
        margin: "8px 10px",
        padding: "10px 12px",
        borderRadius: 8,
        background: "var(--bg-tertiary, #1a1a2e)",
        border: "1px solid var(--accent, #6c63ff)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 16 }}>⏳</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>
          Waiting — resuming in {display}
        </span>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.3 }}>
        {reason}
      </div>
      <div
        style={{
          height: 3,
          borderRadius: 2,
          background: "var(--border-default, #333)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${Math.min(100, elapsed * 100)}%`,
            background: "var(--accent, #6c63ff)",
            borderRadius: 2,
            transition: "width 1s linear",
          }}
        />
      </div>
    </div>
  );
}
