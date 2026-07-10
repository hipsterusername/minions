import { describe, expect, it } from "vitest";
import { themes, skinThemes, themeMap } from "./themes.ts";

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "");
  const value = Number.parseInt(normalized, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function channelToLinear(channel: number): number {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [red, green, blue] = hexToRgb(hex);
  const r = channelToLinear(red);
  const g = channelToLinear(green);
  const b = channelToLinear(blue);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("theme accent text tokens", () => {
  it("defines AA text color for every accent surface", () => {
    for (const theme of themes) {
      const accent = theme.vars["--accent"];
      const textOnAccent = theme.vars["--text-on-accent"];
      if (!accent || !textOnAccent) {
        throw new Error(`${theme.id} is missing accent text tokens`);
      }
      expect(textOnAccent, `${theme.id} defines --text-on-accent`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(contrastRatio(accent, textOnAccent), `${theme.id} accent contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("uses the accent text token for kanban gradient labels", () => {
    for (const theme of themes) {
      expect(theme.vars["--kb-text-on-gradient"], theme.id).toBe("var(--text-on-accent)");
    }
  });
});

describe("permanent skins", () => {
  it("appends the six skins after the base themes, in order", () => {
    expect(skinThemes.map((s) => s.id)).toEqual([
      "glass",
      "ink",
      "blueprint",
      "porcelain",
      "obsidian",
      "nocturne",
    ]);
    // Skins are the tail of the full list, preserving base-theme order.
    expect(themes.slice(-skinThemes.length)).toEqual(skinThemes);
  });

  it("exposes every skin permanently in the picker list", () => {
    for (const skin of skinThemes) {
      expect(themes, `${skin.id} is in the picker`).toContain(skin);
      expect(themeMap[skin.id], `${skin.id} is resolvable`).toBe(skin);
    }
  });

  it("gives every theme a unique id", () => {
    const ids = themes.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every skin a swatch and non-empty palette", () => {
    for (const skin of skinThemes) {
      expect(skin.swatch.bg, `${skin.id} swatch bg`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(skin.swatch.accent, `${skin.id} swatch accent`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(skin.vars["--bg-primary"], `${skin.id} bg`).toBeTruthy();
      expect(skin.vars["--accent"], `${skin.id} accent`).toBeTruthy();
    }
  });
});
