// ── Theme Definitions ─────────────────────────────────────
// Each theme maps to CSS custom properties applied on :root.
//
// Design notes:
//   • Every theme keeps a clear 4-step text hierarchy
//     (--text-primary > --text-secondary > --text-muted > --text-dim).
//   • Background scales 4 deep (primary → secondary → surface → elevated).
//   • Status colours preserve red/yellow/green semantics in every theme,
//     even monochromatic ones (Cathode keeps amber for warning, red for error).
//   • Each theme is opinionated about a colour-theory move:
//       Midnight       — complementary  (deep navy × warm saffron)
//       Alpine         — warm analogous (cream + ink + rust)
//       Deep Current   — split-complementary (teal × amber/coral)
//       Proof Sheet    — neutral + signal (achromatic + signal red)
//       Studio Warm    — warm analogous (espresso → ochre → wine)
//       Cathode        — monochromatic phosphor (with amber/red kept for status)

export interface ThemeDefinition {
  id: string;
  name: string;
  description: string;
  fonts: {
    sans: string;
    mono: string;
  };
  /** Google Fonts import URL fragment (families only, no base URL) */
  googleFontsQuery?: string;
  vars: Record<string, string>;
  /** Accent color for the theme selector swatch */
  swatch: { bg: string; accent: string; text: string };
}

// ── Shared semantic color helpers ─────────────────────────
// These produce theme-appropriate semantic colors.
// Dark themes use the same vibrant status colors; light themes soften them.

const darkSemanticVars = {
  // Status colors. `running` is intentionally distinct from `success`
  // (sky-blue vs emerald) so an in-progress badge doesn't read as done.
  "--status-success": "#34d399",
  "--status-running": "#38bdf8",
  "--status-idle": "#60a5fa",
  "--status-warning": "#fbbf24",
  "--status-error": "#f87171",
  "--status-stopped": "#78716c",
  "--status-waiting": "#a78bfa",
  "--status-creating": "#fbbf24",
  "--status-disconnected": "#64748b",

  // Priority colors
  "--priority-critical": "#ef4444",
  "--priority-high": "#f97316",
  "--priority-medium": "#3b82f6",
  "--priority-low": "#6b7280",

  // Model colors
  "--model-sonnet": "#f59e0b",
  "--model-opus": "#a78bfa",
  "--model-opus-old": "#8b7ab8",
  "--model-haiku": "#34d399",

  // Semantic accents
  "--tool-accent": "#818cf8",
  "--thinking-accent": "#a855f7",
  "--success-color": "#4ade80",
  "--danger-color": "#dc2626",
  "--danger-color-text": "#f87171",
  "--warning-color": "#facc15",
  "--info-color": "#60a5fa",

  // Shadows (dark themes use heavier shadows)
  "--shadow-sm": "0 2px 8px rgba(0,0,0,0.2)",
  "--shadow-md": "0 8px 24px rgba(0,0,0,0.3)",
  "--shadow-lg": "0 8px 32px rgba(0,0,0,0.4)",
  "--overlay-bg": "rgba(0,0,0,0.6)",

  // Interactive state overlays
  "--state-hover": "rgba(255,255,255,0.04)",
  "--state-active": "rgba(255,255,255,0.08)",

  // Tool/thinking backgrounds (low-opacity tints)
  "--tool-bg": "rgba(129, 140, 248, 0.08)",
  "--tool-bg-hover": "rgba(129, 140, 248, 0.12)",
  "--thinking-bg": "rgba(168, 85, 247, 0.06)",
  "--thinking-bg-hover": "rgba(168, 85, 247, 0.10)",
  "--success-bg": "rgba(74, 222, 128, 0.08)",
  "--danger-bg": "rgba(239, 68, 68, 0.08)",
  // Alias kept for components that ask for an `error` rather than `danger`
  // background (e.g. RenderNode status, RoutineNode aborted state).
  "--error-bg": "rgba(239, 68, 68, 0.08)",
  "--warning-bg": "rgba(250, 204, 21, 0.06)",
  "--info-bg": "rgba(96, 165, 250, 0.08)",
  "--muted-bg": "rgba(136, 144, 176, 0.06)",

  // Edge colors
  "--edge-task": "#818cf8",
  "--edge-context": "#4ade80",

  // Note palette (dark)
  "--note-blue-bg": "#1a2744",
  "--note-blue-border": "#1e3a5f",
  "--note-green-bg": "#1a3329",
  "--note-green-border": "#1e4d3d",
  "--note-orange-bg": "#362014",
  "--note-orange-border": "#4a2c1a",
  "--note-purple-bg": "#2d1a3a",
  "--note-purple-border": "#3b1f52",
  "--note-pink-bg": "#3a1a2e",
  "--note-pink-border": "#4a1f3a",
  "--note-slate-bg": "#1e293b",
  "--note-slate-border": "#334155",

  // Markdown node
  "--markdown-bg": "#1a2a1a",
  "--markdown-border": "#2a3a2a",

  // Code inline background
  "--code-bg": "rgba(129, 140, 248, 0.12)",

  // Kanban gradients (gradient-primary is overridden per-theme to use accent)
  "--gradient-primary": "linear-gradient(135deg, #f59e3b, #d97a1c)",
  "--gradient-success": "linear-gradient(135deg, #34d399, #10b981)",
  "--gradient-danger": "linear-gradient(135deg, #f87171, #ef4444)",

  // Kanban text & shadow helpers
  "--kb-text-on-gradient": "#ffffff",
  "--kb-shadow-color": "0 0 0",

  // Streaming
  "--streaming-color": "#60a5fa",
};

const lightSemanticVars: Record<string, string> = {
  // Status colors — darkened for WCAG AA (≥4.5:1) on light backgrounds.
  // `running` is distinct from `success` so an in-progress badge is
  // visually separable from a completed one.
  "--status-success": "#15803d",
  "--status-running": "#0369a1",
  "--status-idle": "#1d4ed8",
  "--status-warning": "#a84e08",
  "--status-error": "#b91c1c",
  "--status-stopped": "#57534e",
  "--status-waiting": "#6d28d9",
  "--status-creating": "#a84e08",
  "--status-disconnected": "#64748b",

  // Priority colors
  "--priority-critical": "#b91c1c",
  "--priority-high": "#c2410c",
  "--priority-medium": "#1d4ed8",
  "--priority-low": "#57534e",

  // Model colors
  "--model-sonnet": "#a84e08",
  "--model-opus": "#6d28d9",
  "--model-opus-old": "#7c5db5",
  "--model-haiku": "#15803d",

  // Semantic accents — darkened for AA compliance on white/light surfaces
  "--tool-accent": "#4338ca",
  "--thinking-accent": "#7e22ce",
  "--success-color": "#15803d",
  "--danger-color": "#b91c1c",
  "--danger-color-text": "#b91c1c",
  "--warning-color": "#a84e08",
  "--info-color": "#1d4ed8",

  // Shadows (light themes use softer shadows)
  "--shadow-sm": "0 2px 8px rgba(60, 50, 35, 0.06)",
  "--shadow-md": "0 8px 24px rgba(60, 50, 35, 0.10)",
  "--shadow-lg": "0 8px 32px rgba(60, 50, 35, 0.14)",
  "--overlay-bg": "rgba(40, 30, 20, 0.32)",

  // Interactive state overlays
  "--state-hover": "rgba(0,0,0,0.03)",
  "--state-active": "rgba(0,0,0,0.06)",

  // Tool/thinking backgrounds — matched to darkened accent colors
  "--tool-bg": "rgba(67, 56, 202, 0.07)",
  "--tool-bg-hover": "rgba(67, 56, 202, 0.12)",
  "--thinking-bg": "rgba(126, 34, 206, 0.06)",
  "--thinking-bg-hover": "rgba(126, 34, 206, 0.10)",
  "--success-bg": "rgba(21, 128, 61, 0.08)",
  "--danger-bg": "rgba(185, 28, 28, 0.08)",
  "--error-bg": "rgba(185, 28, 28, 0.08)",
  "--warning-bg": "rgba(168, 78, 8, 0.06)",
  "--info-bg": "rgba(29, 78, 216, 0.08)",
  "--muted-bg": "rgba(100, 116, 139, 0.06)",

  // Edge colors — darkened for light theme contrast
  "--edge-task": "#4338ca",
  "--edge-context": "#15803d",

  // Note palette (light) — warm-paper biased so they sit on cream surfaces
  "--note-blue-bg": "#dde7f5",
  "--note-blue-border": "#a8c1e0",
  "--note-green-bg": "#dceadc",
  "--note-green-border": "#9bc59b",
  "--note-orange-bg": "#fbe6cf",
  "--note-orange-border": "#e8b97c",
  "--note-purple-bg": "#e6dcf0",
  "--note-purple-border": "#bfa8d6",
  "--note-pink-bg": "#f3dde2",
  "--note-pink-border": "#d8a8b4",
  "--note-slate-bg": "#ede8df",
  "--note-slate-border": "#c5beb0",

  // Markdown node — cream tinted for paper feel
  "--markdown-bg": "#f4f1e8",
  "--markdown-border": "#d8d2c4",

  // Code inline background
  "--code-bg": "rgba(67, 56, 202, 0.09)",

  // Kanban gradients — darkened for AA contrast
  "--gradient-primary": "linear-gradient(135deg, #b8451f, #8a3216)",
  "--gradient-success": "linear-gradient(135deg, #15803d, #14532d)",
  "--gradient-danger": "linear-gradient(135deg, #b91c1c, #7f1d1d)",

  // Kanban text & shadow helpers (inverted for light theme)
  "--kb-text-on-gradient": "#ffffff",
  "--kb-shadow-color": "0 0 0",

  // Streaming
  "--streaming-color": "#1d4ed8",
};

// ── 1. Midnight ───────────────────────────────────────────
// Complementary: deep navy × warm saffron.
// The accent is pulled slightly warmer than the previous orange so it
// reads as ember-against-water rather than pumpkin-against-slate.
const midnight: ThemeDefinition = {
  id: "midnight",
  name: "Midnight",
  description: "Deep navy canvas warmed by a saffron accent",
  fonts: {
    sans: '"DM Sans", "Segoe UI", system-ui, sans-serif',
    mono: '"JetBrains Mono", "Fira Code", monospace',
  },
  googleFontsQuery: "family=DM+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600",
  swatch: { bg: "#0a0e1a", accent: "#f59e3b", text: "#e6ecf5" },
  vars: {
    "--bg-primary": "#0a0e1a",
    "--bg-secondary": "#10131f",
    "--bg-surface": "#161a26",
    "--bg-elevated": "#1c2030",
    "--border-default": "#232940",
    "--border-hover": "#313a5a",
    "--text-primary": "#e6ecf5",
    "--text-secondary": "#aab3c5",
    "--text-muted": "#7c849a",
    "--text-dim": "#5c637a",
    "--accent": "#f59e3b",
    "--accent-dark": "#d97a1c",
    "--dot-grid": "#1a2036",
    "--selection-bg": "rgba(245, 158, 59, 0.28)",
    ...darkSemanticVars,
    "--gradient-primary": "linear-gradient(135deg, #f59e3b, #d97a1c)",
  },
};

// ── 2. Alpine Workshop ────────────────────────────────────
// Warm analogous: cream + ink + rust. Surfaces are tinted cream
// rather than pure white so the paper metaphor holds together.
const alpine: ThemeDefinition = {
  id: "alpine",
  name: "Alpine Workshop",
  description: "Cream paper, deep ink, a rust accent — editorial warmth",
  fonts: {
    sans: '"Space Grotesk", "Segoe UI", system-ui, sans-serif',
    mono: '"IBM Plex Mono", "Fira Code", monospace',
  },
  googleFontsQuery:
    "family=Space+Grotesk:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600",
  swatch: { bg: "#f4f1e8", accent: "#b8451f", text: "#1a1614" },
  vars: {
    "--bg-primary": "#ede9dd",
    "--bg-secondary": "#f4f1e8",
    "--bg-surface": "#fbf8f0",
    "--bg-elevated": "#ffffff",
    "--border-default": "#d8d2c4",
    "--border-hover": "#b8b0a0",
    "--text-primary": "#1a1614",
    "--text-secondary": "#4a443e",
    "--text-muted": "#756c62",
    "--text-dim": "#9a907f",
    "--accent": "#b8451f",
    "--accent-dark": "#8a3216",
    "--dot-grid": "#d6d0c0",
    "--selection-bg": "rgba(184, 69, 31, 0.18)",
    ...lightSemanticVars,
  },
};

// ── 3. Deep Current ───────────────────────────────────────
// Split-complementary: teal accent against an abyssal navy floor,
// with warm amber for tool surfaces and coral for thinking. The
// warm pair is what makes the cool dominant feel deliberate instead
// of monotone.
const deepCurrent: ThemeDefinition = {
  id: "deep-current",
  name: "Deep Current",
  description: "Abyssal navy, teal phosphorescence, amber lantern light",
  fonts: {
    sans: '"Plus Jakarta Sans", "Segoe UI", system-ui, sans-serif',
    mono: '"IBM Plex Mono", "Fira Code", monospace',
  },
  googleFontsQuery:
    "family=Plus+Jakarta+Sans:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600",
  swatch: { bg: "#08111e", accent: "#2dd4bf", text: "#d4e4f0" },
  vars: {
    "--bg-primary": "#08111e",
    "--bg-secondary": "#0c1726",
    "--bg-surface": "#122036",
    "--bg-elevated": "#182b46",
    "--border-default": "#1f3556",
    "--border-hover": "#2c4870",
    "--text-primary": "#d4e4f0",
    "--text-secondary": "#98b3cc",
    "--text-muted": "#6a8aa8",
    "--text-dim": "#4d6a86",
    "--accent": "#2dd4bf",
    "--accent-dark": "#14b8a6",
    "--dot-grid": "#102240",
    "--selection-bg": "rgba(45, 212, 191, 0.22)",
    ...darkSemanticVars,
    // Split-complementary warm pair
    "--tool-accent": "#fbbf24",
    "--thinking-accent": "#fb923c",
    "--tool-bg": "rgba(251, 191, 36, 0.07)",
    "--tool-bg-hover": "rgba(251, 191, 36, 0.12)",
    "--thinking-bg": "rgba(251, 146, 60, 0.06)",
    "--thinking-bg-hover": "rgba(251, 146, 60, 0.10)",
    "--edge-task": "#2dd4bf",
    "--edge-context": "#fbbf24",
    "--streaming-color": "#2dd4bf",
    "--code-bg": "rgba(45, 212, 191, 0.10)",
    // Cooler note tones biased toward sea/sand
    "--note-blue-bg": "#0c1e38",
    "--note-blue-border": "#1a3558",
    "--note-green-bg": "#0c2a26",
    "--note-green-border": "#16433d",
    "--note-orange-bg": "#2a1d0c",
    "--note-orange-border": "#3e2c14",
    "--note-purple-bg": "#1a1c34",
    "--note-purple-border": "#2a2e4a",
    "--note-pink-bg": "#2a1a24",
    "--note-pink-border": "#3a2434",
    "--note-slate-bg": "#162236",
    "--note-slate-border": "#243650",
    "--markdown-bg": "#0c2018",
    "--markdown-border": "#1a3528",
    "--gradient-primary": "linear-gradient(135deg, #2dd4bf, #0d9488)",
    "--gradient-success": "linear-gradient(135deg, #2dd4bf, #14b8a6)",
  },
};

// ── 4. Proof Sheet ────────────────────────────────────────
// Achromatic + signal: brutalist black/white with a single signal red.
// Gray hierarchy widened to four distinct steps. Surfaces drift very
// slightly cool so the warm signal red feels surgical, not decorative.
const proofSheet: ThemeDefinition = {
  id: "proof-sheet",
  name: "Proof Sheet",
  description: "Brutalist neutrals with a single signal red",
  fonts: {
    sans: '"Instrument Sans", "Segoe UI", system-ui, sans-serif',
    mono: '"Space Mono", "Fira Code", monospace',
  },
  googleFontsQuery:
    "family=Instrument+Sans:wght@400;500;600;700&family=Space+Mono:wght@400;700",
  swatch: { bg: "#0d0d0d", accent: "#ed2024", text: "#f5f5f3" },
  vars: {
    "--bg-primary": "#0d0d0d",
    "--bg-secondary": "#161616",
    "--bg-surface": "#1f1f1f",
    "--bg-elevated": "#292929",
    "--border-default": "#353533",
    "--border-hover": "#4d4d4a",
    "--text-primary": "#f5f5f3",
    "--text-secondary": "#b8b8b6",
    "--text-muted": "#888886",
    "--text-dim": "#585856",
    "--accent": "#ed2024",
    "--accent-dark": "#b8181c",
    "--dot-grid": "#222222",
    "--selection-bg": "rgba(237, 32, 36, 0.22)",
    ...darkSemanticVars,
    // Brutalist: tool/thinking are neutral, the only colour in the room is signal red
    "--tool-accent": "#b8b8b6",
    "--thinking-accent": "#888886",
    "--tool-bg": "rgba(184, 184, 182, 0.05)",
    "--tool-bg-hover": "rgba(184, 184, 182, 0.09)",
    "--thinking-bg": "rgba(136, 136, 134, 0.05)",
    "--thinking-bg-hover": "rgba(136, 136, 134, 0.08)",
    "--edge-task": "#b8b8b6",
    "--edge-context": "#888886",
    "--streaming-color": "#f5f5f3",
    "--gradient-primary": "linear-gradient(135deg, #ed2024, #b8181c)",
    "--gradient-success": "linear-gradient(135deg, #34d399, #10b981)",
    "--gradient-danger": "linear-gradient(135deg, #ed2024, #b8181c)",
    // Notes hold a near-neutral palette with subtle hue drift so the user
    // can still tell them apart, but nothing competes with the red signal.
    "--note-blue-bg": "#181a20",
    "--note-blue-border": "#262a32",
    "--note-green-bg": "#181c18",
    "--note-green-border": "#262c26",
    "--note-orange-bg": "#1f1a14",
    "--note-orange-border": "#2e2820",
    "--note-purple-bg": "#1c181f",
    "--note-purple-border": "#2c272f",
    "--note-pink-bg": "#1f181c",
    "--note-pink-border": "#2e262b",
    "--note-slate-bg": "#1c1c1c",
    "--note-slate-border": "#2c2c2c",
    "--markdown-bg": "#181818",
    "--markdown-border": "#282828",
    "--code-bg": "rgba(184, 184, 182, 0.07)",
  },
};

// ── 5. Studio Warm ────────────────────────────────────────
// Warm analogous through and through: espresso shadows, ochre as
// dominant accent, wine for thinking, sand for tools. The previous
// muddy red thinking-accent and cool blue note are gone; the cool
// "blue" note slot still exists for the note picker but is biased
// toward dusk-slate so it complements the warm field rather than
// fighting it.
const studioWarm: ThemeDefinition = {
  id: "studio-warm",
  name: "Studio Warm",
  description: "Espresso shadows, ochre, wine — full warm analogous",
  fonts: {
    sans: '"Nunito Sans", "Segoe UI", system-ui, sans-serif',
    mono: '"JetBrains Mono", "Fira Code", monospace',
  },
  googleFontsQuery:
    "family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500;9..144,600;9..144,700&family=Nunito+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600",
  swatch: { bg: "#1a1410", accent: "#d4a04c", text: "#f0e4d2" },
  vars: {
    "--bg-primary": "#1a1410",
    "--bg-secondary": "#221a14",
    "--bg-surface": "#2c241c",
    "--bg-elevated": "#382e22",
    "--border-default": "#423629",
    "--border-hover": "#5a4a38",
    "--text-primary": "#f0e4d2",
    "--text-secondary": "#c2b09a",
    "--text-muted": "#8e7d68",
    "--text-dim": "#685a48",
    "--accent": "#d4a04c",
    "--accent-dark": "#a87830",
    "--dot-grid": "#2a2018",
    "--selection-bg": "rgba(212, 160, 76, 0.25)",
    ...darkSemanticVars,
    // Warm-analogous overrides
    "--tool-accent": "#d4a76a",
    "--thinking-accent": "#a04958",
    "--tool-bg": "rgba(212, 167, 106, 0.08)",
    "--tool-bg-hover": "rgba(212, 167, 106, 0.12)",
    "--thinking-bg": "rgba(160, 73, 88, 0.07)",
    "--thinking-bg-hover": "rgba(160, 73, 88, 0.11)",
    "--edge-task": "#d4a76a",
    "--edge-context": "#8aa56a",
    "--streaming-color": "#d4a76a",
    "--code-bg": "rgba(212, 167, 106, 0.10)",
    // Notes: the cool slot stays cool (dusk slate) but desaturated so it
    // sits with the warm field. The warm slots get richer earth tones.
    "--note-blue-bg": "#1c2030",
    "--note-blue-border": "#2a3045",
    "--note-green-bg": "#1f2818",
    "--note-green-border": "#2c3822",
    "--note-orange-bg": "#2c2014",
    "--note-orange-border": "#3e2e1c",
    "--note-purple-bg": "#281e26",
    "--note-purple-border": "#3a2e38",
    "--note-pink-bg": "#2e1c22",
    "--note-pink-border": "#402a32",
    "--note-slate-bg": "#241e18",
    "--note-slate-border": "#36302a",
    "--markdown-bg": "#22201a",
    "--markdown-border": "#34302a",
    "--gradient-primary": "linear-gradient(135deg, #d4a04c, #a87830)",
    "--gradient-success": "linear-gradient(135deg, #8aa56a, #5a7a48)",
    "--gradient-danger": "linear-gradient(135deg, #b85050, #8a3030)",
  },
};

// ── 6. Cathode ────────────────────────────────────────────
// Monochromatic phosphor with disciplined intensity gradations.
// The accent steps back from neon (#39ff14 → #4ade80) so it stops
// burning at small text sizes. Status semantics survive: warning
// keeps amber, error keeps red — the green-on-green identity is
// loud enough already.
const cathode: ThemeDefinition = {
  id: "cathode",
  name: "Cathode",
  description: "Phosphor green on black — terminal monochrome with kept semantics",
  fonts: {
    sans: '"JetBrains Mono", "Fira Code", monospace',
    mono: '"JetBrains Mono", "Fira Code", monospace',
  },
  googleFontsQuery: "family=JetBrains+Mono:wght@300;400;500;600;700",
  swatch: { bg: "#050805", accent: "#4ade80", text: "#c8e8d0" },
  vars: {
    "--bg-primary": "#050805",
    "--bg-secondary": "#0a120a",
    "--bg-surface": "#0e180e",
    "--bg-elevated": "#142014",
    "--border-default": "#1c2e1c",
    "--border-hover": "#2a4a2a",
    "--text-primary": "#c8e8d0",
    "--text-secondary": "#88b890",
    "--text-muted": "#5e8866",
    "--text-dim": "#3e5e44",
    "--accent": "#4ade80",
    "--accent-dark": "#22c55e",
    "--dot-grid": "#0e1e0e",
    "--selection-bg": "rgba(74, 222, 128, 0.18)",
    ...darkSemanticVars,
    // Monochromatic phosphor for tool + accent surfaces, but warning
    // and error stay amber/red so dashboards remain legible.
    "--tool-accent": "#4ade80",
    "--thinking-accent": "#2dd4bf",
    "--success-color": "#4ade80",
    "--info-color": "#67e8f9",
    "--streaming-color": "#4ade80",
    "--status-success": "#4ade80",
    // Cyan phosphor for in-progress so it doesn't collide with the
    // success-green badge in monochrome dashboards.
    "--status-running": "#67e8f9",
    "--status-idle": "#67e8f9",
    "--status-warning": "#fbbf24",
    "--status-creating": "#fbbf24",
    "--status-error": "#ef4444",
    "--warning-color": "#fbbf24",
    "--priority-critical": "#ef4444",
    "--priority-high": "#fbbf24",
    "--priority-medium": "#67e8f9",
    "--priority-low": "#5e8866",
    "--tool-bg": "rgba(74, 222, 128, 0.06)",
    "--tool-bg-hover": "rgba(74, 222, 128, 0.10)",
    "--thinking-bg": "rgba(45, 212, 191, 0.05)",
    "--thinking-bg-hover": "rgba(45, 212, 191, 0.08)",
    "--edge-task": "#4ade80",
    "--edge-context": "#67e8f9",
    // Monochrome-tinted notes — every note slot lives on the green axis
    "--note-blue-bg": "#08160e",
    "--note-blue-border": "#102818",
    "--note-green-bg": "#0a1a0a",
    "--note-green-border": "#142e14",
    "--note-orange-bg": "#16140a",
    "--note-orange-border": "#262410",
    "--note-purple-bg": "#0e1218",
    "--note-purple-border": "#1a2228",
    "--note-pink-bg": "#16100c",
    "--note-pink-border": "#262018",
    "--note-slate-bg": "#0c120c",
    "--note-slate-border": "#182418",
    "--markdown-bg": "#081208",
    "--markdown-border": "#102410",
    "--code-bg": "rgba(74, 222, 128, 0.09)",
    "--gradient-primary": "linear-gradient(135deg, #4ade80, #22c55e)",
    "--gradient-success": "linear-gradient(135deg, #4ade80, #16a34a)",
    "--gradient-danger": "linear-gradient(135deg, #ef4444, #b91c1c)",
  },
};

// ── Exports ───────────────────────────────────────────────

export const themes: ThemeDefinition[] = [
  midnight,
  alpine,
  deepCurrent,
  proofSheet,
  studioWarm,
  cathode,
];

export const themeMap = Object.fromEntries(themes.map((t) => [t.id, t])) as Record<
  string,
  ThemeDefinition
>;

export const DEFAULT_THEME_ID = "midnight";

/**
 * Apply a theme's CSS variables and fonts to the document root.
 */
export function applyTheme(themeId: string): void {
  const theme = themeMap[themeId] ?? themeMap[DEFAULT_THEME_ID]!;
  const root = document.documentElement;

  // Apply all CSS variables
  for (const [prop, value] of Object.entries(theme.vars)) {
    root.style.setProperty(prop, value);
  }

  // Apply font families
  root.style.setProperty("--font-sans", theme.fonts.sans);
  root.style.setProperty("--font-mono", theme.fonts.mono);

  // Apply selection color
  root.dataset["theme"] = theme.id;
}

/**
 * Build the full Google Fonts URL for all themes (preload all).
 */
export function buildGoogleFontsUrl(): string {
  const families = themes
    .map((t) => t.googleFontsQuery)
    .filter(Boolean)
    // Deduplicate identical family queries
    .filter((q, i, arr) => arr.indexOf(q) === i);

  return `https://fonts.googleapis.com/css2?${families.join("&")}&display=swap`;
}
