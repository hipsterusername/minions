/**
 * LeaderLoadingScreen — eye→crown morph used while a project boots.
 *
 * The "in-progress" eye performs its saccade scan, then the crown
 * draws in inside the iris. The pupil never disappears: it migrates
 * from its final saccade target to the dot that lives beneath the
 * crown in the leader glyph (Canvas.tsx), so the transition reads
 * as continuity, not a swap.
 *
 * Two animation modes:
 *   - default (loop): infinite scan → reveal → dissolve back → repeat.
 *   - one-shot (`oneShot` prop): single 2.6s play through to steady
 *     crown, hold 1s on the final frame, then fire `onComplete`.
 *     Used at app boot so the user sees a complete leader emergence
 *     before the project fades in.
 *
 * The same SVG/CSS pair is exported as a self-contained string so it
 * can be embedded in a data: URI (e.g. dashboard previews).
 */

import { useEffect, useRef } from "react";

interface LeaderLoadingScreenProps {
  message?: string;
  /** Pixel size of the glyph. Default 96. */
  size?: number;
  /**
   * If true, animation plays once and stops on the steady-crown
   * frame (no dissolve). After {@link ONE_SHOT_TOTAL_MS} the
   * `onComplete` callback fires.
   */
  oneShot?: boolean;
  /** Fired when the one-shot play + hold are done. No-op when looping. */
  onComplete?: () => void;
}

/** One-shot animation duration (seconds). */
const ONE_SHOT_ANIM_S = 1.4;
/** Hold duration on the steady-crown frame after the animation ends (seconds). */
const ONE_SHOT_HOLD_S = 0.8;
/** Total ms before `onComplete` fires in one-shot mode. */
export const ONE_SHOT_TOTAL_MS = (ONE_SHOT_ANIM_S + ONE_SHOT_HOLD_S) * 1000;

/**
 * SVG markup with embedded keyframes. Self-contained so it can be
 * dropped into a data: URI without external CSS.
 *
 * ViewBox is 0 0 80 80. Crown geometry mirrors the toolbar leader
 * icon (Canvas.tsx) scaled and translated into this viewBox.
 *
 * The one-shot variants (`ll-saccade-once`, `ll-crown-once`) are
 * activated by an ancestor `.ll-once` class — descendant selectors
 * win over the looping defaults via specificity.
 */
export const LEADER_LOADING_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" role="img"
     aria-label="Loading leader">
  <style>
    /* Iris circle is static — it's the eye socket throughout. */
    .ll-iris  { fill: none; stroke: currentColor; stroke-width: 1.5; }

    /* ── Default loop ───────────────────────────────────── */
    .ll-pupil { transform-box: fill-box; transform-origin: center;
                animation: ll-saccade 4s cubic-bezier(.16,1,.3,1) infinite;
                fill: currentColor; }
    @keyframes ll-saccade {
      0%   { transform: translate(-8px,-6px) scale(1); }
      8%   { transform: translate(-8px,-6px) scale(1); }
      14%  { transform: translate( 7px,-7px) scale(1); }
      26%  { transform: translate( 7px,-7px) scale(1); }
      32%  { transform: translate( 9px, 4px) scale(1); }
      42%  { transform: translate( 9px, 4px) scale(1); }
      48%  { transform: translate(-6px, 5px) scale(1); }
      55%  { transform: translate(-6px, 5px) scale(1); }
      62%  { transform: translate( 0px,10px) scale(0.6); }
      88%  { transform: translate( 0px,10px) scale(0.6); }
      100% { transform: translate(-8px,-6px) scale(1); }
    }

    .ll-crown { animation: ll-crown 4s ease-out infinite;
                fill: currentColor;
                stroke: currentColor; stroke-width: 0.5;
                stroke-linejoin: round;
                stroke-dasharray: 64; }
    @keyframes ll-crown {
      0%, 60%  { opacity: 0; stroke-dashoffset: 64; }
      72%, 88% { opacity: 1; stroke-dashoffset: 0; }
      94%, 100%{ opacity: 0; stroke-dashoffset: 64; }
    }

    /* ── One-shot: ends at steady crown, no dissolve ───── */
    .ll-once .ll-pupil {
      animation: ll-saccade-once ${ONE_SHOT_ANIM_S}s cubic-bezier(.16,1,.3,1) 1 forwards;
    }
    @keyframes ll-saccade-once {
      0%   { transform: translate(-8px,-6px) scale(1); }
      4%   { transform: translate(-8px,-6px) scale(1); }
      10%  { transform: translate( 7px,-7px) scale(1); }
      22%  { transform: translate( 7px,-7px) scale(1); }
      28%  { transform: translate( 9px, 4px) scale(1); }
      38%  { transform: translate( 9px, 4px) scale(1); }
      44%  { transform: translate(-6px, 5px) scale(1); }
      55%  { transform: translate(-6px, 5px) scale(1); }
      65%  { transform: translate( 0px,10px) scale(0.6); }
      100% { transform: translate( 0px,10px) scale(0.6); }
    }

    .ll-once .ll-crown {
      animation: ll-crown-once ${ONE_SHOT_ANIM_S}s ease-out 1 forwards;
    }
    @keyframes ll-crown-once {
      0%, 60%   { opacity: 0; stroke-dashoffset: 64; }
      88%, 100% { opacity: 1; stroke-dashoffset: 0; }
    }

    @media (prefers-reduced-motion: reduce) {
      .ll-pupil, .ll-crown { animation: none; }
      .ll-crown            { opacity: 1; stroke-dashoffset: 0; }
    }
  </style>

  <!-- Iris (the eye socket) — static -->
  <circle class="ll-iris" cx="40" cy="40" r="16"/>

  <!-- Crown zigzag: source M12 24L10 16L16 20L20 14L24 20L30 16L28 24Z
       scaled ×0.5 around (40,38) so it fits inside the iris. -->
  <path class="ll-crown"
        d="M32 43 L30 35 L36 39 L40 33 L44 39 L50 35 L48 43 Z"/>

  <!-- Pupil / crown-dot (fill currentColor; performs the saccade) -->
  <circle class="ll-pupil" cx="40" cy="40" r="4"/>
</svg>`.trim();

/** Encoded data: URI for embedding the animation in image tags. */
export const LEADER_LOADING_DATA_URI =
  `data:image/svg+xml;utf8,${encodeURIComponent(LEADER_LOADING_SVG)}`;

export function LeaderLoadingScreen({
  message = "Loading project",
  size = 96,
  oneShot = false,
  onComplete,
}: LeaderLoadingScreenProps) {
  // In one-shot mode, fire onComplete exactly once at mount + total
  // duration. Stabilize via ref so a fresh inline `onComplete` arrow
  // on the parent doesn't re-arm the timeout on every parent render
  // — that pushes the fade out indefinitely and the user sees the
  // held final frame instead of the cross-fade.
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  useEffect(() => {
    if (!oneShot) return;
    const t = setTimeout(() => onCompleteRef.current?.(), ONE_SHOT_TOTAL_MS);
    return () => clearTimeout(t);
  }, [oneShot]);

  return (
    <div
      data-testid="leader-loading"
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 18,
        background: "var(--bg-primary)",
        color: "var(--accent)",
        fontFamily: "var(--font-mono)",
      }}
    >
      <div
        className={oneShot ? "ll-once" : undefined}
        style={{ width: size, height: size, color: "var(--accent)" }}
        // Inline the same SVG used by the data: URI so animations
        // run inside the document (data: URIs sandbox CSS in some
        // browsers).
        dangerouslySetInnerHTML={{ __html: LEADER_LOADING_SVG }}
      />
      <div
        style={{
          fontSize: 12,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: "var(--text-muted)",
        }}
      >
        {message}
        <span className="ll-dots" aria-hidden="true">
          <style>{LL_DOTS_CSS}</style>
        </span>
      </div>
    </div>
  );
}

const LL_DOTS_CSS = `
.ll-dots::after {
  content: '';
  display: inline-block;
  width: 1.6em;
  text-align: left;
  animation: ll-dots 1.4s steps(4, end) infinite;
}
@keyframes ll-dots {
  0%   { content: ''; }
  25%  { content: '.'; }
  50%  { content: '..'; }
  75%  { content: '...'; }
  100% { content: ''; }
}`;
