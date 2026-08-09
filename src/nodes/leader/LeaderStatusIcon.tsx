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
    />
  );
}
