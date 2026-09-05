import { forwardRef, useId } from "react";
import type { LucideProps } from "lucide-react";
import "./crew-icon.css";

/** Graph's three-eye mark, drawn on the same 40px grid as the leader. */
export const CrewIcon = forwardRef<SVGSVGElement, LucideProps & { active?: boolean }>(
  function CrewIcon({ size = 24, color = "currentColor", strokeWidth = 2,
    active = false, className = "", absoluteStrokeWidth = false, ...props }, ref) {
    const id = useId();
    const weight = absoluteStrokeWidth ? Number(strokeWidth) * 40 / Number(size) : strokeWidth;
    return (
      <svg ref={ref} width={size} height={size} viewBox="0 0 40 40" fill="none"
        color={color} aria-hidden="true" focusable="false"
        {...props} className={`crew-icon${active ? " crew-icon--active" : ""} ${className}`}>
        <defs>
          {/* Cut out overlapping shells so the mark works on every surface. */}
          <mask id={`${id}-left`} maskUnits="userSpaceOnUse" x="0" y="0" width="40" height="40">
            <rect width="40" height="40" fill="white" />
            <circle cx="27" cy="13" r="10" fill="black" />
            <circle cx="20" cy="28" r="10" fill="black" />
          </mask>
          <mask id={`${id}-right`} maskUnits="userSpaceOnUse" x="0" y="0" width="40" height="40">
            <rect width="40" height="40" fill="white" />
            <circle cx="20" cy="28" r="10" fill="black" />
          </mask>
        </defs>
        {([[13, 13], [27, 13], [20, 28]] as const).map(([cx, cy], index) => (
          <g key={index} mask={index < 2 ? `url(#${id}-${index === 0 ? "left" : "right"})` : undefined}>
            <circle cx={cx} cy={cy} r="9" stroke="currentColor" strokeWidth={weight} />
            <circle className={`crew-icon__pupil crew-icon__pupil--${index}`}
              cx={cx} cy={cy} r="2.5" fill="currentColor" />
          </g>
        ))}
      </svg>
    );
  },
);
