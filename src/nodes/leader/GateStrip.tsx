import { MinionsIcon, type MinionsIconName } from "../../components/MinionsIcon.tsx";
import { useMemo, useState } from "react";
import "../../gate-strip.css";

export type GateStatus =
  | "not_required"
  | "required_pending"
  | "passed"
  | "failed"
  | "waived";

export interface MergeGateVerdict {
  allowed: boolean;
  mode: "off" | "advisory" | "enforced";
  gates: Array<{
    id: string;
    name: string;
    status: GateStatus;
    reason: string;
  }>;
}

interface GateStripProps {
  gates: MergeGateVerdict | null | undefined;
  sessionKey: string | null | undefined;
  socketSend?: ((data: unknown) => void) | undefined;
}

const STATUS_META: Record<
  GateStatus,
  { glyph: MinionsIconName; label: string; verification: string }
> = {
  not_required: { glyph: "minus", label: "Not required", verification: "not required" },
  required_pending: { glyph: "warning", label: "Pending", verification: "pending" },
  passed: { glyph: "check", label: "Passed", verification: "passed" },
  failed: { glyph: "close", label: "Failed", verification: "failed" },
  waived: { glyph: "waived", label: "Waived", verification: "waived" },
};

export function GateStrip({ gates, sessionKey, socketSend }: GateStripProps) {
  const [expandedGateId, setExpandedGateId] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const visibleGates = useMemo(
    () => (gates?.gates ?? []).filter((gate) => gate.status !== "not_required"),
    [gates],
  );

  if (!gates || gates.mode === "off" || visibleGates.length === 0) return null;

  const advisory = gates.mode === "advisory";

  return (
    <section className="gate-strip" aria-label="Review gates">
      <div className="gate-strip__chips">
        {visibleGates.map((gate) => {
          const meta = STATUS_META[gate.status];
          const expanded = expandedGateId === gate.id;
          return (
            <div className="gate-strip__gate" key={gate.id}>
              <button
                type="button"
                className={`gate-strip__chip gate-strip__chip--${gate.status}`}
                aria-label={`${gate.name} ${meta.label}`}
                aria-expanded={expanded}
                onClick={() => setExpandedGateId(expanded ? null : gate.id)}
              >
                <span className="gate-strip__glyph" aria-hidden="true">
                  <MinionsIcon name={meta.glyph} size={13} />
                </span>
                <span className="gate-strip__name">{gate.name}</span>
                <span className="gate-strip__status">{meta.label}</span>
              </button>
              {expanded && (
                <div className="gate-strip__detail">
                  <div className="gate-strip__row">
                    <span>Reason</span>
                    <p>{gate.reason}</p>
                  </div>
                  <div className="gate-strip__row">
                    <span>Verification</span>
                    <p>{meta.verification}</p>
                  </div>
                  <form
                    className="gate-strip__waive"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const reason = reasons[gate.id]?.trim();
                      if (!reason || advisory || !sessionKey || !socketSend) return;
                      socketSend({
                        type: "waive_review_gate",
                        sessionKey,
                        gateId: gate.id,
                        reason,
                      });
                    }}
                  >
                    <input
                      aria-label={`Waiver reason for ${gate.name}`}
                      value={reasons[gate.id] ?? ""}
                      onChange={(event) =>
                        setReasons((current) => ({
                          ...current,
                          [gate.id]: event.target.value,
                        }))
                      }
                      disabled={advisory || gate.status === "waived"}
                      placeholder={
                        advisory ? "Advisory mode only" : "Waiver reason"
                      }
                    />
                    <button
                      type="submit"
                      disabled={
                        advisory ||
                        gate.status === "waived" ||
                        !sessionKey ||
                        !socketSend ||
                        !reasons[gate.id]?.trim()
                      }
                    >
                      Waive
                    </button>
                  </form>
                  {advisory && (
                    <div className="gate-strip__note">
                      Advisory mode: gates are informational.
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
