// ── Theme Definitions ─────────────────────────────────────
// Each theme maps to CSS custom properties applied on :root

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
  // Status colors
  "--status-success": "#34d399",
  "--status-running": "#34d399",
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
  "--gradient-primary": "linear-gradient(135deg, #f0883e, #e05b2a)",
  "--gradient-success": "linear-gradient(135deg, #34d399, #10b981)",
  "--gradient-danger": "linear-gradient(135deg, #f87171, #ef4444)",

  // Kanban text & shadow helpers
  "--kb-text-on-gradient": "#ffffff",
  "--kb-shadow-color": "0 0 0",

  // Streaming
  "--streaming-color": "#60a5fa",
};

const lightSemanticVars: Record<string, string> = {
  // Status colors — darkened for WCAG AA (≥4.5:1) on light backgrounds
  "--status-success": "#14793a",
  "--status-running": "#14793a",
  "--status-idle": "#2563eb",
  "--status-warning": "#a84e08",
  "--status-error": "#b91c1c",
  "--status-stopped": "#57534e",
  "--status-waiting": "#6d28d9",
  "--status-creating": "#a84e08",
  "--status-disconnected": "#64748b",

  // Priority colors
  "--priority-critical": "#b91c1c",
  "--priority-high": "#c2410c",
  "--priority-medium": "#2563eb",
  "--priority-low": "#57534e",

  // Model colors
  "--model-sonnet": "#a84e08",
  "--model-opus": "#6d28d9",
  "--model-opus-old": "#7c5db5",
  "--model-haiku": "#14793a",

  // Semantic accents — darkened for AA compliance on white/light surfaces
  "--tool-accent": "#4f46e5",
  "--thinking-accent": "#7e22ce",
  "--success-color": "#14793a",
  "--danger-color": "#b91c1c",
  "--danger-color-text": "#b91c1c",
  "--warning-color": "#a84e08",
  "--info-color": "#1d4ed8",

  // Shadows (light themes use softer, colored shadows)
  "--shadow-sm": "0 2px 8px rgba(0,0,0,0.06)",
  "--shadow-md": "0 8px 24px rgba(0,0,0,0.1)",
  "--shadow-lg": "0 8px 32px rgba(0,0,0,0.12)",
  "--overlay-bg": "rgba(0,0,0,0.3)",

  // Interactive state overlays
  "--state-hover": "rgba(0,0,0,0.03)",
  "--state-active": "rgba(0,0,0,0.06)",

  // Tool/thinking backgrounds — matched to darkened accent colors
  "--tool-bg": "rgba(79, 70, 229, 0.08)",
  "--tool-bg-hover": "rgba(79, 70, 229, 0.14)",
  "--thinking-bg": "rgba(126, 34, 206, 0.06)",
  "--thinking-bg-hover": "rgba(126, 34, 206, 0.10)",
  "--success-bg": "rgba(20, 121, 58, 0.08)",
  "--danger-bg": "rgba(185, 28, 28, 0.08)",
  "--warning-bg": "rgba(168, 78, 8, 0.06)",
  "--info-bg": "rgba(29, 78, 216, 0.08)",
  "--muted-bg": "rgba(100, 116, 139, 0.06)",

  // Edge colors — darkened for light theme contrast
  "--edge-task": "#4f46e5",
  "--edge-context": "#14793a",

  // Note palette (light)
  "--note-blue-bg": "#dbeafe",
  "--note-blue-border": "#93c5fd",
  "--note-green-bg": "#dcfce7",
  "--note-green-border": "#86efac",
  "--note-orange-bg": "#ffedd5",
  "--note-orange-border": "#fdba74",
  "--note-purple-bg": "#ede9fe",
  "--note-purple-border": "#c4b5fd",
  "--note-pink-bg": "#fce7f3",
  "--note-pink-border": "#f9a8d4",
  "--note-slate-bg": "#f1f5f9",
  "--note-slate-border": "#cbd5e1",

  // Markdown node
  "--markdown-bg": "#f0fdf4",
  "--markdown-border": "#bbf7d0",

  // Code inline background
  "--code-bg": "rgba(79, 70, 229, 0.1)",

  // Kanban gradients — darkened for AA contrast
  "--gradient-primary": "linear-gradient(135deg, #c2410c, #9a3412)",
  "--gradient-success": "linear-gradient(135deg, #14793a, #166534)",
  "--gradient-danger": "linear-gradient(135deg, #b91c1c, #991b1b)",

  // Kanban text & shadow helpers (inverted for light theme)
  "--kb-text-on-gradient": "#ffffff",
  "--kb-shadow-color": "0 0 0",

  // Streaming
  "--streaming-color": "#1d4ed8",
};

// ── 1. Midnight (Current) ─────────────────────────────────
const midnight: ThemeDefinition = {
  id: "midnight",
  name: "Midnight",
  description: "The original dark canvas — cool-toned with orange accents",
  fonts: {
    sans: '"DM Sans", "Segoe UI", system-ui, sans-serif',
    mono: '"JetBrains Mono", "Fira Code", monospace',
  },
  googleFontsQuery: "family=DM+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600",
  swatch: { bg: "#0a0c14", accent: "#f0883e", text: "#e2e8f0" },
  vars: {
    "--bg-primary": "#0a0c14",
    "--bg-secondary": "#0f1117",
    "--bg-surface": "#141620",
    "--bg-elevated": "#181c2a",
    "--border-default": "#1e2030",
    "--border-hover": "#2a3050",
    "--text-primary": "#e2e8f0",
    "--text-secondary": "#94a3b8",
    "--text-muted": "#8890b0",
    "--text-dim": "#8494b4",
    "--accent": "#f0883e",
    "--accent-dark": "#e05b2a",
    "--dot-grid": "#1a1d2e",
    "--selection-bg": "rgba(240, 136, 62, 0.3)",
    ...darkSemanticVars,
  },
};

// ── 2. Alpine Workshop ────────────────────────────────────
const alpine: ThemeDefinition = {
  id: "alpine",
  name: "Alpine Workshop",
  description: "Warm light theme — editorial precision, papery tones",
  fonts: {
    sans: '"Space Grotesk", "Segoe UI", system-ui, sans-serif',
    mono: '"IBM Plex Mono", "Fira Code", monospace',
  },
  googleFontsQuery:
    "family=Space+Grotesk:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600",
  swatch: { bg: "#faf8f5", accent: "#c2410c", text: "#1c1917" },
  vars: {
    "--bg-primary": "#f5f2ed",
    "--bg-secondary": "#faf8f5",
    "--bg-surface": "#ffffff",
    "--bg-elevated": "#ffffff",
    "--border-default": "#d6d3cd",
    "--border-hover": "#b8b3a8",
    "--text-primary": "#1c1917",
    "--text-secondary": "#57534e",
    "--text-muted": "#706860",
    "--text-dim": "#635b52",
    "--accent": "#c2410c",
    "--accent-dark": "#9a3412",
    "--dot-grid": "#d6d3cd",
    "--selection-bg": "rgba(194, 65, 12, 0.15)",
    ...lightSemanticVars,
  },
};

// ── 3. Deep Current ───────────────────────────────────────
const deepCurrent: ThemeDefinition = {
  id: "deep-current",
  name: "Deep Current",
  description: "Oceanic dark — navy depths with teal and amber accents",
  fonts: {
    sans: '"Plus Jakarta Sans", "Segoe UI", system-ui, sans-serif',
    mono: '"IBM Plex Mono", "Fira Code", monospace',
  },
  googleFontsQuery:
    "family=Plus+Jakarta+Sans:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600",
  swatch: { bg: "#0c1220", accent: "#0d9488", text: "#cbd5e1" },
  vars: {
    "--bg-primary": "#0c1220",
    "--bg-secondary": "#101828",
    "--bg-surface": "#162032",
    "--bg-elevated": "#1c2a3e",
    "--border-default": "#1e3048",
    "--border-hover": "#2a4060",
    "--text-primary": "#cbd5e1",
    "--text-secondary": "#7e9aba",
    "--text-muted": "#7e9ebe",
    "--text-dim": "#7a9ec0",
    "--accent": "#14b8a6",
    "--accent-dark": "#0d9488",
    "--dot-grid": "#162840",
    "--selection-bg": "rgba(13, 148, 136, 0.25)",
    ...darkSemanticVars,
    // Deep Current overrides: teal-tinted tool accents
    "--edge-task": "#0d9488",
    "--tool-accent": "#0ea5e9",
    "--tool-bg": "rgba(14, 165, 233, 0.08)",
    "--tool-bg-hover": "rgba(14, 165, 233, 0.12)",
    "--streaming-color": "#0ea5e9",
    // Warmer note tones
    "--note-blue-bg": "#0c1e38",
    "--note-blue-border": "#1a3558",
    "--note-orange-bg": "#2a1a10",
    "--note-orange-border": "#3a2818",
    "--markdown-bg": "#0c2018",
    "--markdown-border": "#1a3528",
    "--gradient-primary": "linear-gradient(135deg, #0d9488, #0f766e)",
  },
};

// ── 4. Proof Sheet ────────────────────────────────────────
const proofSheet: ThemeDefinition = {
  id: "proof-sheet",
  name: "Proof Sheet",
  description: "Brutalist high-contrast — black, white, and signal red",
  fonts: {
    sans: '"Instrument Sans", "Segoe UI", system-ui, sans-serif',
    mono: '"Space Mono", "Fira Code", monospace',
  },
  googleFontsQuery:
    "family=Instrument+Sans:wght@400;500;600;700&family=Space+Mono:wght@400;700",
  swatch: { bg: "#111110", accent: "#ff3b30", text: "#eeeeec" },
  vars: {
    "--bg-primary": "#111110",
    "--bg-secondary": "#191918",
    "--bg-surface": "#222220",
    "--bg-elevated": "#2a2a28",
    "--border-default": "#333330",
    "--border-hover": "#444440",
    "--text-primary": "#eeeeec",
    "--text-secondary": "#aaaaaa",
    "--text-muted": "#949494",
    "--text-dim": "#969696",
    "--accent": "#ff3b30",
    "--accent-dark": "#cc2f26",
    "--dot-grid": "#222220",
    "--selection-bg": "rgba(255, 59, 48, 0.2)",
    ...darkSemanticVars,
    // Proof Sheet: red-centric overrides
    "--tool-accent": "#aaaaaa",
    "--thinking-accent": "#888888",
    "--tool-bg": "rgba(170, 170, 170, 0.06)",
    "--tool-bg-hover": "rgba(170, 170, 170, 0.10)",
    "--thinking-bg": "rgba(136, 136, 136, 0.05)",
    "--thinking-bg-hover": "rgba(136, 136, 136, 0.08)",
    "--edge-task": "#aaaaaa",
    "--edge-context": "#aaaaaa",
    "--streaming-color": "#eeeeec",
    "--gradient-primary": "linear-gradient(135deg, #ff3b30, #cc2f26)",
    "--gradient-success": "linear-gradient(135deg, #34d399, #10b981)",
    "--gradient-danger": "linear-gradient(135deg, #ff3b30, #cc2f26)",
    // Neutral note palette
    "--note-blue-bg": "#1a1a20",
    "--note-blue-border": "#2a2a32",
    "--note-green-bg": "#181e18",
    "--note-green-border": "#282e28",
    "--note-orange-bg": "#201a14",
    "--note-orange-border": "#302a22",
    "--note-purple-bg": "#1e1a22",
    "--note-purple-border": "#2e2a32",
    "--note-pink-bg": "#221a1e",
    "--note-pink-border": "#322a2e",
    "--note-slate-bg": "#1e1e1e",
    "--note-slate-border": "#303030",
    "--markdown-bg": "#181818",
    "--markdown-border": "#282828",
    "--code-bg": "rgba(170, 170, 170, 0.08)",
  },
};

// ── 5. Studio Warm ────────────────────────────────────────
const studioWarm: ThemeDefinition = {
  id: "studio-warm",
  name: "Studio Warm",
  description: "Cozy dark — espresso tones, golden ochre, creative warmth",
  fonts: {
    sans: '"Nunito Sans", "Segoe UI", system-ui, sans-serif',
    mono: '"JetBrains Mono", "Fira Code", monospace',
  },
  googleFontsQuery:
    "family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500;9..144,600;9..144,700&family=Nunito+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600",
  swatch: { bg: "#1a1614", accent: "#c08b30", text: "#e8ddd0" },
  vars: {
    "--bg-primary": "#1a1614",
    "--bg-secondary": "#211c18",
    "--bg-surface": "#2c2420",
    "--bg-elevated": "#362e28",
    "--border-default": "#3e342c",
    "--border-hover": "#504438",
    "--text-primary": "#e8ddd0",
    "--text-secondary": "#b0a090",
    "--text-muted": "#aa9a82",
    "--text-dim": "#a89880",
    "--accent": "#c08b30",
    "--accent-dark": "#a07020",
    "--dot-grid": "#2a2218",
    "--selection-bg": "rgba(192, 139, 48, 0.25)",
    ...darkSemanticVars,
    // Warm overrides
    "--tool-accent": "#d4a76a",
    "--thinking-accent": "#b06060",
    "--tool-bg": "rgba(212, 167, 106, 0.08)",
    "--tool-bg-hover": "rgba(212, 167, 106, 0.12)",
    "--thinking-bg": "rgba(176, 96, 96, 0.06)",
    "--thinking-bg-hover": "rgba(176, 96, 96, 0.10)",
    "--edge-task": "#d4a76a",
    "--edge-context": "#6bab6b",
    "--streaming-color": "#d4a76a",
    // Warm-tinted note palette
    "--note-blue-bg": "#1e2030",
    "--note-blue-border": "#2a3045",
    "--note-green-bg": "#1e2818",
    "--note-green-border": "#2a3822",
    "--note-orange-bg": "#2c2014",
    "--note-orange-border": "#3e2e1c",
    "--note-purple-bg": "#281e28",
    "--note-purple-border": "#3a2e3a",
    "--note-pink-bg": "#2e1c22",
    "--note-pink-border": "#402a32",
    "--note-slate-bg": "#242018",
    "--note-slate-border": "#363020",
    "--markdown-bg": "#22201a",
    "--markdown-border": "#34302a",
    "--code-bg": "rgba(212, 167, 106, 0.1)",
    "--gradient-primary": "linear-gradient(135deg, #d4a76a, #c08b30)",
    "--gradient-success": "linear-gradient(135deg, #6bab6b, #4a8a4a)",
    "--gradient-danger": "linear-gradient(135deg, #c06060, #a04040)",
  },
};

// ── 6. Cathode ────────────────────────────────────────────
const cathode: ThemeDefinition = {
  id: "cathode",
  name: "Cathode",
  description: "Retro-future terminal — phosphor green on black",
  fonts: {
    sans: '"JetBrains Mono", "Fira Code", monospace',
    mono: '"JetBrains Mono", "Fira Code", monospace',
  },
  googleFontsQuery: "family=JetBrains+Mono:wght@300;400;500;600;700",
  swatch: { bg: "#050505", accent: "#39ff14", text: "#d0ffe0" },
  vars: {
    "--bg-primary": "#050805",
    "--bg-secondary": "#0a120a",
    "--bg-surface": "#0e180e",
    "--bg-elevated": "#142014",
    "--border-default": "#1a2e1a",
    "--border-hover": "#254025",
    "--text-primary": "#d0ffe0",
    "--text-secondary": "#80c890",
    "--text-muted": "#6aa070",
    "--text-dim": "#68a870",
    "--accent": "#39ff14",
    "--accent-dark": "#28cc10",
    "--dot-grid": "#0e1e0e",
    "--selection-bg": "rgba(57, 255, 20, 0.15)",
    ...darkSemanticVars,
    // Cathode: phosphor-green overrides
    "--tool-accent": "#39ff14",
    "--thinking-accent": "#20cc40",
    "--success-color": "#39ff14",
    "--info-color": "#39ff14",
    "--streaming-color": "#39ff14",
    "--tool-bg": "rgba(57, 255, 20, 0.06)",
    "--tool-bg-hover": "rgba(57, 255, 20, 0.10)",
    "--thinking-bg": "rgba(32, 204, 64, 0.05)",
    "--thinking-bg-hover": "rgba(32, 204, 64, 0.08)",
    "--edge-task": "#39ff14",
    "--edge-context": "#39ff14",
    // Green-tinted notes
    "--note-blue-bg": "#08140e",
    "--note-blue-border": "#102818",
    "--note-green-bg": "#0a1a0a",
    "--note-green-border": "#142e14",
    "--note-orange-bg": "#141208",
    "--note-orange-border": "#282410",
    "--note-purple-bg": "#0e1014",
    "--note-purple-border": "#1a2028",
    "--note-pink-bg": "#14100e",
    "--note-pink-border": "#28201a",
    "--note-slate-bg": "#0c120c",
    "--note-slate-border": "#182418",
    "--markdown-bg": "#081208",
    "--markdown-border": "#102410",
    "--code-bg": "rgba(57, 255, 20, 0.08)",
    "--gradient-primary": "linear-gradient(135deg, #39ff14, #28cc10)",
    "--gradient-success": "linear-gradient(135deg, #39ff14, #20aa10)",
    "--gradient-danger": "linear-gradient(135deg, #ff4040, #cc2020)",
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
