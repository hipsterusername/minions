import { Bot } from "lucide-react";

export function AgentRoleSettings({
  role,
  description,
  children,
}: {
  role: "Leader" | "Minion";
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-agent" aria-label={`${role} defaults`}>
      <div className="settings-agent__identity">
        <span className="settings-agent__icon"><Bot size={15} aria-hidden="true" /></span>
        <span>
          <strong>{role}</strong>
          <small>{description}</small>
        </span>
      </div>
      <div className="settings-agent__configuration">
        <label className="settings-field-label">Model &amp; reasoning</label>
        {children}
      </div>
    </section>
  );
}

export function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings-toggle">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="settings-toggle__track" aria-hidden="true"><span /></span>
    </label>
  );
}
