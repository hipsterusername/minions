export function LeaderStatusIcon({
  active,
  size,
  decorative = false,
}: {
  active: boolean;
  size: number;
  decorative?: boolean;
}) {
  const label = active ? "Active" : "Idle";

  return (
    <span
      className="leader-status-icon"
      data-state={active ? "active" : "idle"}
      style={{ width: size, height: size }}
      {...(decorative
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": label })}
    >
      {active && (
        <svg viewBox="0 0 40 40" fill="none" aria-hidden="true" focusable="false">
          <circle
            cx="20"
            cy="20"
            r="16"
            fill="currentColor"
            fillOpacity="0.15"
            stroke="currentColor"
            strokeWidth="2"
          />
          <path
            className="leader-status-icon__crown"
            d="M12 24L10 16L16 20L20 14L24 20L30 16L28 24H12Z"
            fill="currentColor"
          />
          <circle
            className="leader-status-icon__pupil"
            cx="20"
            cy="28"
            r="2"
            fill="currentColor"
          />
        </svg>
      )}
    </span>
  );
}
