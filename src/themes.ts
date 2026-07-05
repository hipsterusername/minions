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
