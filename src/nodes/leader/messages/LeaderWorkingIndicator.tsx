import { SaccadeEye } from "../../RenderNode.tsx";

/** Persistent, low-emphasis activity marker shown beneath the active chat. */
export function LeaderWorkingIndicator() {
  return (
    <div
      aria-label="Leader is working"
      className="leader-working-indicator"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 2px 2px",
        color: "var(--text-muted)",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        lineHeight: 1,
        letterSpacing: "0.04em",
      }}
    >
      <SaccadeEye
        seed="leader-working"
        size={12}
        pupilSize={3}
        amplitude={1.8}
        color="var(--info-color)"
        borderWidth={1}
        glow={false}
        testId="leader-working-pupil"
      />
      <span>working</span>
    </div>
  );
}
