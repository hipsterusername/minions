import { LayoutDashboard, UsersRound } from "lucide-react";

const LEADER_CAPABILITIES = [
  {
    icon: UsersRound,
    title: "Spawn Minions",
    copy: "Delegate focused work in parallel, then bring the results back together.",
  },
  {
    icon: LayoutDashboard,
    title: "Display a dashboard",
    copy: "Turn progress, decisions, or results into a clear view you can scan.",
  },
] as const;

/** First-run guidance presented in the same header pattern as the New leader workspace. */
export function ActivityOnboarding() {
  return (
    <header className="act-launch-head act-onboarding" aria-label="Getting started with Minions">
      <div className="act-onboarding__intro">
        <span className="act-launch-eyebrow">Your first leader</span>
        <h2>What should it do?</h2>
        <p>Describe the outcome below.</p>
      </div>

      <div className="act-onboarding__capability-group">
        <p className="act-onboarding__capabilities-note">You can tell the leader to:</p>
        <ul className="act-onboarding__capabilities" aria-label="Things a leader can do">
          {LEADER_CAPABILITIES.map(({ icon: Icon, title, copy }) => (
            <li key={title}>
              <span className="act-onboarding__capability-icon" aria-hidden>
                <Icon size={15} strokeWidth={1.9} />
              </span>
              <span>
                <strong>{title}</strong>
                <small>{copy}</small>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </header>
  );
}
