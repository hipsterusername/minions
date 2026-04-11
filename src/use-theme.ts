import { createContext, useContext } from "react";
import type { ThemeDefinition } from "./themes.ts";
import { themes, DEFAULT_THEME_ID } from "./themes.ts";

// ── Context ───────────────────────────────────────────────

export interface ThemeContextValue {
  themeId: string;
  theme: ThemeDefinition;
  setTheme: (id: string) => void;
  themes: ThemeDefinition[];
}

export const ThemeContext = createContext<ThemeContextValue>({
  themeId: DEFAULT_THEME_ID,
  theme: themes[0]!,
  setTheme: () => {},
  themes,
});

// ── Hook ──────────────────────────────────────────────────

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

// ── localStorage persistence ──────────────────────────────

const STORAGE_KEY = "canvas-theme";

export function loadPersistedThemeId(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export function persistThemeId(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // localStorage might be unavailable
  }
}
