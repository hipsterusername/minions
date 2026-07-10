// ── Theme Definitions ─────────────────────────────────────
// Each theme maps to CSS custom properties applied on :root.
//
// Design notes:
//   • Every theme keeps a clear 4-step text hierarchy
//     (--text-primary > --text-secondary > --text-muted > --text-dim).
//   • Background scales 4 deep (primary → secondary → surface → elevated).
//   • Status colours preserve red/yellow/green semantics in every theme.
//   • Each theme is opinionated about a colour-theory move:
//       Midnight       — complementary  (deep navy × warm saffron)
//       Alpine         — warm analogous (cream + ink + rust)
//       Deep Current   — split-complementary (teal × amber/coral)
//       Signal Slate   — achromatic + electric signal (slate × sky)
//       Sage Ledger    — cool analogous light (sage × blue-green)
//       Aurora Console — triadic dark (mint × violet × amber)

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
  "--model-fable": "#f472b6",
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
  "--state-hover": "rgba(255,255,255,0.07)",
  "--state-active": "rgba(255,255,255,0.13)",

  // Tool/thinking backgrounds (low-opacity tints)
  "--tool-bg": "rgba(129, 140, 248, 0.08)",
  "--tool-bg-hover": "rgba(129, 140, 248, 0.12)",
  "--thinking-bg": "rgba(168, 85, 247, 0.06)",
  "--thinking-bg-hover": "rgba(168, 85, 247, 0.10)",
  "--success-bg": "rgba(74, 222, 128, 0.08)",
  "--danger-bg": "rgba(239, 68, 68, 0.08)",
  // Alias kept for components that ask for an `error` rather than `danger`
  // background (e.g. RenderNode status).
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
  "--text-on-accent": "#0a0e1a",
  "--kb-text-on-gradient": "var(--text-on-accent)",
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
  "--model-fable": "#be185d",
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
  "--state-hover": "rgba(0,0,0,0.055)",
  "--state-active": "rgba(0,0,0,0.10)",

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
  "--text-on-accent": "#ffffff",
  "--kb-text-on-gradient": "var(--text-on-accent)",
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

// ── 4. Signal Slate ────────────────────────────────────────
// Achromatic + electric signal: graphite surfaces with sky-blue action.
// The old red signal overloaded danger semantics; this version keeps the
// editorial restraint but gives interaction states a safer, clearer accent.
const proofSheet: ThemeDefinition = {
  id: "proof-sheet",
  name: "Signal Slate",
  description: "Graphite neutrals with crisp sky-blue action",
  fonts: {
    sans: '"Instrument Sans", "Segoe UI", system-ui, sans-serif',
    mono: '"IBM Plex Mono", "Fira Code", monospace',
  },
  googleFontsQuery:
    "family=Instrument+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600",
  swatch: { bg: "#0b1020", accent: "#7dd3fc", text: "#eef4ff" },
  vars: {
    "--bg-primary": "#0b1020",
    "--bg-secondary": "#111827",
    "--bg-surface": "#172033",
    "--bg-elevated": "#202a3d",
    "--border-default": "#2b3852",
    "--border-hover": "#3a4a6a",
    "--text-primary": "#eef4ff",
    "--text-secondary": "#b9c6d8",
    "--text-muted": "#8492a8",
    "--text-dim": "#5e6b80",
    "--accent": "#7dd3fc",
    "--accent-dark": "#38bdf8",
    "--dot-grid": "#17233a",
    "--selection-bg": "rgba(125, 211, 252, 0.22)",
    ...darkSemanticVars,
    "--tool-accent": "#93c5fd",
    "--thinking-accent": "#c4b5fd",
    "--tool-bg": "rgba(147, 197, 253, 0.08)",
    "--tool-bg-hover": "rgba(147, 197, 253, 0.13)",
    "--thinking-bg": "rgba(196, 181, 253, 0.07)",
    "--thinking-bg-hover": "rgba(196, 181, 253, 0.11)",
    "--edge-task": "#7dd3fc",
    "--edge-context": "#a7f3d0",
    "--streaming-color": "#7dd3fc",
    "--code-bg": "rgba(125, 211, 252, 0.10)",
    "--note-blue-bg": "#12213a",
    "--note-blue-border": "#1f3b61",
    "--note-green-bg": "#10271f",
    "--note-green-border": "#1c4638",
    "--note-orange-bg": "#2b2113",
    "--note-orange-border": "#4a361d",
    "--note-purple-bg": "#221a38",
    "--note-purple-border": "#372b5a",
    "--note-pink-bg": "#2d1a2a",
    "--note-pink-border": "#4b2c46",
    "--note-slate-bg": "#1a2434",
    "--note-slate-border": "#2c3a50",
    "--markdown-bg": "#122519",
    "--markdown-border": "#21402d",
    "--gradient-primary": "linear-gradient(135deg, #7dd3fc, #2563eb)",
  },
};

// ── 5. Sage Ledger ────────────────────────────────────────
// Cool analogous light: sage paper, deep evergreen ink, blue-green action.
// This replaces the all-warm studio palette with a calmer operational
// light theme that keeps muted states and borders distinct.
const studioWarm: ThemeDefinition = {
  id: "studio-warm",
  name: "Sage Ledger",
  description: "Sage paper, evergreen ink, blue-green action",
  fonts: {
    sans: '"Source Sans 3", "Segoe UI", system-ui, sans-serif',
    mono: '"IBM Plex Mono", "Fira Code", monospace',
  },
  googleFontsQuery:
    "family=Source+Sans+3:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600",
  swatch: { bg: "#eef2ea", accent: "#256d85", text: "#17201b" },
  vars: {
    "--bg-primary": "#eef2ea",
    "--bg-secondary": "#f6f7f2",
    "--bg-surface": "#fbfcf7",
    "--bg-elevated": "#ffffff",
    "--border-default": "#d1d9cc",
    "--border-hover": "#aab8a4",
    "--text-primary": "#17201b",
    "--text-secondary": "#3f4f45",
    "--text-muted": "#68766c",
    "--text-dim": "#8b968d",
    "--accent": "#256d85",
    "--accent-dark": "#194e60",
    "--dot-grid": "#d9e1d4",
    "--selection-bg": "rgba(37, 109, 133, 0.18)",
    ...lightSemanticVars,
    "--tool-accent": "#2f6f4e",
    "--thinking-accent": "#5b5ea6",
    "--tool-bg": "rgba(47, 111, 78, 0.07)",
    "--tool-bg-hover": "rgba(47, 111, 78, 0.12)",
    "--thinking-bg": "rgba(91, 94, 166, 0.06)",
    "--thinking-bg-hover": "rgba(91, 94, 166, 0.10)",
    "--edge-task": "#256d85",
    "--edge-context": "#2f6f4e",
    "--streaming-color": "#256d85",
    "--code-bg": "rgba(37, 109, 133, 0.09)",
    "--note-blue-bg": "#dcebf0",
    "--note-blue-border": "#9bc0ca",
    "--note-green-bg": "#ddebdc",
    "--note-green-border": "#9fc49b",
    "--note-orange-bg": "#f3e4cc",
    "--note-orange-border": "#d6ad72",
    "--note-purple-bg": "#e4e1f0",
    "--note-purple-border": "#b6afd2",
    "--note-pink-bg": "#efdfe5",
    "--note-pink-border": "#d1a7b5",
    "--note-slate-bg": "#e8ece4",
    "--note-slate-border": "#bdc7b8",
    "--markdown-bg": "#edf5e9",
    "--markdown-border": "#c2d4bc",
    "--gradient-primary": "linear-gradient(135deg, #256d85, #194e60)",
    "--gradient-success": "linear-gradient(135deg, #2f6f4e, #1f5138)",
  },
};

// ── 6. Aurora Console ─────────────────────────────────────
// Triadic dark: near-black teal, mint action, violet reasoning, amber tools.
// It keeps the focused console feeling without collapsing every semantic
// channel into green-on-green phosphor.
const cathode: ThemeDefinition = {
  id: "cathode",
  name: "Aurora Console",
  description: "Dark teal console with mint, violet, and amber signals",
  fonts: {
    sans: '"Recursive", "JetBrains Mono", "Segoe UI", system-ui, sans-serif',
    mono: '"JetBrains Mono", "Fira Code", monospace',
  },
  googleFontsQuery:
    "family=Recursive:wght@400;500;600;700&family=JetBrains+Mono:wght@300;400;500;600;700",
  swatch: { bg: "#061014", accent: "#5eead4", text: "#d6ece8" },
  vars: {
    "--bg-primary": "#061014",
    "--bg-secondary": "#0a171c",
    "--bg-surface": "#102229",
    "--bg-elevated": "#17313a",
    "--border-default": "#21434c",
    "--border-hover": "#2d5a66",
    "--text-primary": "#d6ece8",
    "--text-secondary": "#9fc2bc",
    "--text-muted": "#6f928b",
    "--text-dim": "#4d6863",
    "--accent": "#5eead4",
    "--accent-dark": "#2dd4bf",
    "--dot-grid": "#0d2025",
    "--selection-bg": "rgba(94, 234, 212, 0.20)",
    ...darkSemanticVars,
    "--tool-accent": "#fbbf24",
    "--thinking-accent": "#c084fc",
    "--info-color": "#38bdf8",
    "--streaming-color": "#5eead4",
    "--tool-bg": "rgba(251, 191, 36, 0.07)",
    "--tool-bg-hover": "rgba(251, 191, 36, 0.12)",
    "--thinking-bg": "rgba(192, 132, 252, 0.06)",
    "--thinking-bg-hover": "rgba(192, 132, 252, 0.10)",
    "--edge-task": "#5eead4",
    "--edge-context": "#c084fc",
    "--code-bg": "rgba(94, 234, 212, 0.10)",
    "--note-blue-bg": "#0c1e2b",
    "--note-blue-border": "#18384c",
    "--note-green-bg": "#0c261f",
    "--note-green-border": "#164638",
    "--note-orange-bg": "#2a1f0c",
    "--note-orange-border": "#463616",
    "--note-purple-bg": "#1d1730",
    "--note-purple-border": "#322650",
    "--note-pink-bg": "#2a1728",
    "--note-pink-border": "#462640",
    "--note-slate-bg": "#122229",
    "--note-slate-border": "#243b45",
    "--markdown-bg": "#0c221a",
    "--markdown-border": "#1a3c2e",
    "--gradient-primary": "linear-gradient(135deg, #5eead4, #0891b2)",
    "--gradient-success": "linear-gradient(135deg, #34d399, #059669)",
    "--gradient-danger": "linear-gradient(135deg, #ef4444, #b91c1c)",
  },
};

// ══════════════════════════════════════════════════════════
//  SKINS — full look-and-feel "retheming" options
//
//  Unlike the six base themes above, each skin is a complete
//  look-and-feel change, not just a palette. The matching
//  `src/theme-skins/<id>.css` file reshapes structure (radii, borders,
//  elevation, blur, density, display type) via `:root[data-theme="<id>"]`
//  overrides. Skins are permanent picker entries alongside the base themes.
// ══════════════════════════════════════════════════════════

/**
 * Per-skin status/semantic palette. Base themes share one generic status
 * set; skins override it so success/running/warning/error harmonise with
 * the skin's hue while preserving green/blue/amber/red semantics. The
 * matching background washes are derived with `color-mix` so they always
 * track the foreground colour. Spread *after* `...darkSemanticVars` /
 * `...lightSemanticVars` so it wins.
 */
function statusPalette(c: {
  success: string;
  running: string;
  warning: string;
  error: string;
  waiting: string;
  idle: string;
  info: string;
}): Record<string, string> {
  return {
    "--status-success": c.success,
    "--status-running": c.running,
    "--status-idle": c.idle,
    "--status-warning": c.warning,
    "--status-error": c.error,
    "--status-waiting": c.waiting,
    "--status-creating": c.warning,
    "--success-color": c.success,
    "--danger-color": c.error,
    "--danger-color-text": c.error,
    "--warning-color": c.warning,
    "--info-color": c.info,
    "--success-bg": `color-mix(in srgb, ${c.success} 12%, transparent)`,
    "--danger-bg": `color-mix(in srgb, ${c.error} 12%, transparent)`,
    "--error-bg": `color-mix(in srgb, ${c.error} 12%, transparent)`,
    "--warning-bg": `color-mix(in srgb, ${c.warning} 12%, transparent)`,
    "--info-bg": `color-mix(in srgb, ${c.info} 12%, transparent)`,
  };
}

// ── Skin 1. Aurora Glass ──────────────────────────────────
// Premium glassmorphism: deep violet-black, luminous violet accent,
// frosted translucent surfaces, generous radii and soft glow.
const auroraGlass: ThemeDefinition = {
  id: "glass",
  name: "Aurora Glass",
  description: "Frosted glassmorphism — violet-black with a luminous accent",
  fonts: {
    sans: '"Plus Jakarta Sans", "Segoe UI", system-ui, sans-serif',
    mono: '"JetBrains Mono", "Fira Code", monospace',
  },
  googleFontsQuery:
    "family=Plus+Jakarta+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600",
  swatch: { bg: "#0c0a1e", accent: "#a78bfa", text: "#ece9ff" },
  vars: {
    "--bg-primary": "#0b0918",
    "--bg-secondary": "#141029",
    "--bg-surface": "#1a1638",
    "--bg-elevated": "#221c48",
    "--border-default": "#2e2758",
    "--border-hover": "#463b80",
    "--text-primary": "#ece9ff",
    "--text-secondary": "#bcb4e2",
    "--text-muted": "#8981ab",
    "--text-dim": "#615a86",
    "--accent": "#a78bfa",
    "--accent-dark": "#7c5cf0",
    "--dot-grid": "#1d1742",
    "--selection-bg": "rgba(167, 139, 250, 0.30)",
    ...darkSemanticVars,
    // Cool, luminous status set to sit on the violet canvas.
    // running = electric cyan (pops hard vs the violet accent); idle = faded indigo-grey.
    ...statusPalette({
      success: "#4ade80",
      running: "#22d3ee",
      warning: "#fbbf24",
      error: "#fb7185",
      waiting: "#c084fc",
      idle: "#6b7294",
      info: "#60a5fa",
    }),
    "--tool-accent": "#818cf8",
    "--thinking-accent": "#c084fc",
    "--tool-bg": "rgba(129, 140, 248, 0.10)",
    "--tool-bg-hover": "rgba(129, 140, 248, 0.16)",
    "--thinking-bg": "rgba(192, 132, 252, 0.08)",
    "--thinking-bg-hover": "rgba(192, 132, 252, 0.13)",
    "--edge-task": "#a78bfa",
    "--edge-context": "#67e8f9",
    "--streaming-color": "#a78bfa",
    "--code-bg": "rgba(167, 139, 250, 0.13)",
    "--shadow-md": "0 8px 32px rgba(76, 29, 149, 0.35)",
    "--shadow-lg": "0 16px 48px rgba(76, 29, 149, 0.45)",
    "--gradient-primary": "linear-gradient(135deg, #a78bfa, #6366f1)",
  },
};

// ── Skin 2. Broadsheet Ink ────────────────────────────────
// Editorial print: warm paper, near-black ink, oxblood accent, serif
// display, hairline rules and a flat, shadowless surface treatment.
const broadsheetInk: ThemeDefinition = {
  id: "ink",
  name: "Broadsheet Ink",
  description: "Editorial print — warm paper, oxblood ink, serif display",
  fonts: {
    sans: '"Nunito Sans", "Segoe UI", system-ui, sans-serif',
    mono: '"IBM Plex Mono", "Fira Code", monospace',
  },
  googleFontsQuery:
    "family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Nunito+Sans:wght@300;400;500;600;700",
  swatch: { bg: "#f4efe6", accent: "#8a2b2b", text: "#1c1a17" },
  vars: {
    "--bg-primary": "#f1ebe0",
    "--bg-secondary": "#f8f3ea",
    "--bg-surface": "#fdfbf6",
    "--bg-elevated": "#ffffff",
    "--border-default": "#dcd2c1",
    "--border-hover": "#b9ab90",
    "--text-primary": "#1c1a17",
    "--text-secondary": "#433f39",
    "--text-muted": "#6f695d",
    "--text-dim": "#948d7e",
    "--accent": "#8a2b2b",
    "--accent-dark": "#6d1f1f",
    "--dot-grid": "#e1d9c9",
    "--selection-bg": "rgba(138, 43, 43, 0.16)",
    ...lightSemanticVars,
    // Muted editorial inks — darkened for AA on warm paper.
    // running = vivid press blue (pops on cream); idle = faded warm grey.
    ...statusPalette({
      success: "#3f7d4e",
      running: "#1857c9",
      warning: "#9a5f12",
      error: "#9d2f2f",
      waiting: "#6d4c9e",
      idle: "#9a927f",
      info: "#2f6f8f",
    }),
    "--tool-accent": "#4338ca",
    "--thinking-accent": "#7e22ce",
    "--edge-task": "#8a2b2b",
    "--edge-context": "#3f6f4e",
    "--streaming-color": "#8a2b2b",
    "--code-bg": "rgba(138, 43, 43, 0.09)",
    "--note-blue-bg": "#e4ebf2",
    "--note-blue-border": "#b6c6d8",
    "--note-green-bg": "#e7eddf",
    "--note-green-border": "#bccaa4",
    "--note-orange-bg": "#f3e6d2",
    "--note-orange-border": "#d9bd90",
    "--note-purple-bg": "#eae2ef",
    "--note-purple-border": "#c7b6d4",
    "--note-pink-bg": "#f1e2e2",
    "--note-pink-border": "#d6b0b0",
    "--note-slate-bg": "#e8e6df",
    "--note-slate-border": "#c6c1b4",
    "--markdown-bg": "#f4f0e6",
    "--markdown-border": "#d8cdb8",
    "--text-on-accent": "#fdfbf6",
    "--gradient-primary": "linear-gradient(135deg, #8a2b2b, #6d1f1f)",
  },
};

// ── Skin 3. Blueprint ─────────────────────────────────────
// Technical brutalist: blueprint navy, cyan signal, zero-radius crisp
// borders, monospaced labels and a faint drafting-grid canvas.
const blueprint: ThemeDefinition = {
  id: "blueprint",
  name: "Blueprint",
  description: "Technical brutalist — blueprint navy, cyan signal, drafting grid",
  fonts: {
    sans: '"Space Grotesk", "Segoe UI", system-ui, sans-serif',
    mono: '"JetBrains Mono", "Fira Code", monospace',
  },
  googleFontsQuery:
    "family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700",
  swatch: { bg: "#0a1626", accent: "#38bdf8", text: "#dfeaf5" },
  vars: {
    "--bg-primary": "#0a1626",
    "--bg-secondary": "#0e1d31",
    "--bg-surface": "#12253c",
    "--bg-elevated": "#173049",
    "--border-default": "#254a70",
    "--border-hover": "#3a6a9c",
    "--text-primary": "#dfeaf5",
    "--text-secondary": "#a7c0d8",
    "--text-muted": "#6f8aa6",
    "--text-dim": "#4d6480",
    "--accent": "#38bdf8",
    "--accent-dark": "#0ea5e9",
    "--dot-grid": "#183a5c",
    "--selection-bg": "rgba(56, 189, 248, 0.24)",
    ...darkSemanticVars,
    // Instrument-panel signals. success = green so cyan is free for running;
    // running = electric cyan (pops on navy); idle = faded slate.
    ...statusPalette({
      success: "#4ade80",
      running: "#22d3ee",
      warning: "#fbbf24",
      error: "#f87171",
      waiting: "#a78bfa",
      idle: "#5c7690",
      info: "#38bdf8",
    }),
    "--tool-accent": "#38bdf8",
    "--thinking-accent": "#c084fc",
    "--edge-task": "#38bdf8",
    "--edge-context": "#fbbf24",
    "--streaming-color": "#38bdf8",
    "--code-bg": "rgba(56, 189, 248, 0.12)",
    "--note-blue-bg": "#0d2338",
    "--note-blue-border": "#1d456b",
    "--note-green-bg": "#0c2a24",
    "--note-green-border": "#1a4d40",
    "--note-orange-bg": "#2b2110",
    "--note-orange-border": "#4a3a1a",
    "--note-purple-bg": "#1e1c3a",
    "--note-purple-border": "#332f5c",
    "--note-pink-bg": "#2a1a2c",
    "--note-pink-border": "#472948",
    "--note-slate-bg": "#132436",
    "--note-slate-border": "#264056",
    "--markdown-bg": "#0c2233",
    "--markdown-border": "#1c3f57",
    "--gradient-primary": "linear-gradient(135deg, #38bdf8, #0ea5e9)",
  },
};

// ── Skin 4. Porcelain ─────────────────────────────────────
// Soft-UI neumorphism: warm off-white, tactile extruded surfaces built
// from paired light/dark shadows, borderless cards and generous radii.
const porcelain: ThemeDefinition = {
  id: "porcelain",
  name: "Porcelain",
  description: "Soft-UI neumorphism — warm off-white with tactile, extruded surfaces",
  fonts: {
    sans: '"Plus Jakarta Sans", "Segoe UI", system-ui, sans-serif',
    mono: '"IBM Plex Mono", "Fira Code", monospace',
  },
  googleFontsQuery:
    "family=Plus+Jakarta+Sans:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600",
  swatch: { bg: "#e8ebf1", accent: "#6d7cf0", text: "#2b3040" },
  vars: {
    "--bg-primary": "#e6e9f0",
    "--bg-secondary": "#eaedf3",
    "--bg-surface": "#eef1f6",
    "--bg-elevated": "#f4f6fa",
    "--border-default": "#d6dae6",
    "--border-hover": "#c2c8da",
    "--text-primary": "#2b3040",
    "--text-secondary": "#515873",
    "--text-muted": "#7c839a",
    "--text-dim": "#a2a8bd",
    "--accent": "#4f5fd6",
    "--accent-dark": "#3d4bbd",
    "--dot-grid": "#d3d8e6",
    "--selection-bg": "rgba(79, 95, 214, 0.16)",
    ...lightSemanticVars,
    // Soft, desaturated status tones for the pastel soft-UI surface.
    // running = vivid blue (pops on pale lavender); idle = faded cool grey.
    ...statusPalette({
      success: "#2f8f6f",
      running: "#1a5fd0",
      warning: "#a8701f",
      error: "#bf4b4b",
      waiting: "#6d4fc0",
      idle: "#9aa0b0",
      info: "#3f6bc4",
    }),
    "--tool-accent": "#4338ca",
    "--thinking-accent": "#7e22ce",
    "--edge-task": "#4f5fd6",
    "--edge-context": "#2f9e7f",
    "--streaming-color": "#4f5fd6",
    "--code-bg": "rgba(79, 95, 214, 0.09)",
    "--shadow-sm": "3px 3px 7px rgba(163, 170, 190, 0.55), -3px -3px 7px rgba(255, 255, 255, 0.9)",
    "--shadow-md": "6px 6px 14px rgba(163, 170, 190, 0.55), -6px -6px 14px rgba(255, 255, 255, 0.9)",
    "--shadow-lg": "9px 9px 22px rgba(163, 170, 190, 0.55), -9px -9px 22px rgba(255, 255, 255, 0.92)",
    "--note-blue-bg": "#e2e7f4",
    "--note-blue-border": "#c3cde6",
    "--note-green-bg": "#e2eee7",
    "--note-green-border": "#bcd6c5",
    "--note-orange-bg": "#f2e8dc",
    "--note-orange-border": "#dcc6a9",
    "--note-purple-bg": "#e9e3f3",
    "--note-purple-border": "#cabce2",
    "--note-pink-bg": "#f2e2ec",
    "--note-pink-border": "#dcb6cd",
    "--note-slate-bg": "#e7eaf1",
    "--note-slate-border": "#cbd1e0",
    "--markdown-bg": "#e9edf4",
    "--markdown-border": "#ccd3e3",
    "--text-on-accent": "#f4f6fa",
    "--gradient-primary": "linear-gradient(135deg, #6d7cf0, #4f5fd6)",
  },
};

// ── Skin 5. Obsidian ──────────────────────────────────────
// OLED luxe minimal: true black, platinum text, a single restrained
// champagne-gold accent, hairline borders and near-flat elevation.
const obsidian: ThemeDefinition = {
  id: "obsidian",
  name: "Obsidian",
  description: "OLED luxe minimal — true black with a champagne-gold accent",
  fonts: {
    sans: '"Instrument Sans", "Segoe UI", system-ui, sans-serif',
    mono: '"Space Mono", "JetBrains Mono", monospace',
  },
  googleFontsQuery:
    "family=Instrument+Sans:wght@400;500;600;700&family=Space+Mono:wght@400;700",
  swatch: { bg: "#000000", accent: "#e3b866", text: "#f2f2f0" },
  vars: {
    "--bg-primary": "#000000",
    "--bg-secondary": "#0b0b0c",
    "--bg-surface": "#131315",
    "--bg-elevated": "#1b1b1e",
    "--border-default": "#26262a",
    "--border-hover": "#3a3a40",
    "--text-primary": "#f2f2f0",
    "--text-secondary": "#b7b7b2",
    "--text-muted": "#82827d",
    "--text-dim": "#5a5a56",
    "--accent": "#e3b866",
    "--accent-dark": "#c99a44",
    "--dot-grid": "#1a1a1d",
    "--selection-bg": "rgba(227, 184, 102, 0.24)",
    ...darkSemanticVars,
    // Refined luxe tones, but running pops: bright azure against the black;
    // idle = faded warm grey so dormant sessions recede.
    ...statusPalette({
      success: "#8fb7a3",
      running: "#4ab8e8",
      warning: "#e3b866",
      error: "#d98a7a",
      waiting: "#b79ce0",
      idle: "#63635f",
      info: "#7fb0c9",
    }),
    "--tool-accent": "#d4b483",
    "--thinking-accent": "#b79ce0",
    "--edge-task": "#e3b866",
    "--edge-context": "#8fb7a3",
    "--streaming-color": "#e3b866",
    "--code-bg": "rgba(227, 184, 102, 0.12)",
    "--shadow-md": "0 8px 24px rgba(0, 0, 0, 0.6)",
    "--shadow-lg": "0 16px 40px rgba(0, 0, 0, 0.7)",
    "--text-on-accent": "#1b1b1e",
    "--note-blue-bg": "#0c141d",
    "--note-blue-border": "#1c2c3d",
    "--note-green-bg": "#0c1712",
    "--note-green-border": "#1c3227",
    "--note-orange-bg": "#1a140a",
    "--note-orange-border": "#332814",
    "--note-purple-bg": "#150f1d",
    "--note-purple-border": "#2a2038",
    "--note-pink-bg": "#1a0f17",
    "--note-pink-border": "#331f2c",
    "--note-slate-bg": "#121214",
    "--note-slate-border": "#26262a",
    "--markdown-bg": "#0c130e",
    "--markdown-border": "#1d2a20",
    "--gradient-primary": "linear-gradient(135deg, #e3b866, #b8863c)",
    "--gradient-success": "linear-gradient(135deg, #8fb7a3, #4f8f6f)",
  },
};

// ── Skin 6. Nocturne ──────────────────────────────────────
// Gradient luxe dark: deep plum-to-indigo surfaces, rose-gold accent and
// a warm ambient glow — richer and more chromatic than the OLED minimal.
const nocturne: ThemeDefinition = {
  id: "nocturne",
  name: "Nocturne",
  description: "Gradient luxe dark — plum-to-indigo surfaces with a rose-gold accent",
  fonts: {
    sans: '"Space Grotesk", "Segoe UI", system-ui, sans-serif',
    mono: '"JetBrains Mono", "Fira Code", monospace',
  },
  googleFontsQuery:
    "family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600",
  swatch: { bg: "#160f24", accent: "#f0a58f", text: "#f0e9f5" },
  vars: {
    "--bg-primary": "#140d20",
    "--bg-secondary": "#1c142e",
    "--bg-surface": "#241a3a",
    "--bg-elevated": "#2d2148",
    "--border-default": "#3a2c5c",
    "--border-hover": "#52407e",
    "--text-primary": "#f0e9f5",
    "--text-secondary": "#c5b6d6",
    "--text-muted": "#93839f", // muted plum-grey
    "--text-dim": "#685a78",
    "--accent": "#f0a58f",
    "--accent-dark": "#dd7d63",
    "--dot-grid": "#241a3c",
    "--selection-bg": "rgba(240, 165, 143, 0.26)",
    ...darkSemanticVars,
    // Warm luxe set. running = bright cyan (pops against the plum bg and the
    // rose-gold accent); idle = faded plum-grey.
    ...statusPalette({
      success: "#7fd6b0",
      running: "#3ec8f0",
      warning: "#f0c05a",
      error: "#f0748f",
      waiting: "#c4a5f0",
      idle: "#7a7088",
      info: "#a5b4fc",
    }),
    "--tool-accent": "#c4a5f0",
    "--thinking-accent": "#e0a5d6",
    "--edge-task": "#f0a58f",
    "--edge-context": "#c4a5f0",
    "--streaming-color": "#f0a58f",
    "--code-bg": "rgba(240, 165, 143, 0.12)",
    "--shadow-md": "0 8px 28px rgba(40, 12, 45, 0.5)",
    "--shadow-lg": "0 16px 44px rgba(40, 12, 45, 0.6)",
    "--note-blue-bg": "#171d33",
    "--note-blue-border": "#28345a",
    "--note-green-bg": "#152a26",
    "--note-green-border": "#254a42",
    "--note-orange-bg": "#2e1e1a",
    "--note-orange-border": "#4c322a",
    "--note-purple-bg": "#241a3a",
    "--note-purple-border": "#3d2d60",
    "--note-pink-bg": "#2e1a2c",
    "--note-pink-border": "#4c2c48",
    "--note-slate-bg": "#1d1830",
    "--note-slate-border": "#332a4e",
    "--markdown-bg": "#1a1330",
    "--markdown-border": "#2f2350",
    "--text-on-accent": "#2a1420",
    "--gradient-primary": "linear-gradient(135deg, #f0a58f, #b06ab3)",
    "--gradient-success": "linear-gradient(135deg, #7fd6b0, #3f9e7f)",
  },
};

// ── Exports ───────────────────────────────────────────────

/**
 * Skins, in picker order — full look-and-feel themes (palette + a scoped
 * `src/theme-skins/<id>.css` stylesheet). Appended to {@link themes}.
 */
export const skinThemes: ThemeDefinition[] = [
  auroraGlass,
  broadsheetInk,
  blueprint,
  porcelain,
  obsidian,
  nocturne,
];

export const themes: ThemeDefinition[] = [
  midnight,
  alpine,
  deepCurrent,
  proofSheet,
  studioWarm,
  cathode,
  ...skinThemes,
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
