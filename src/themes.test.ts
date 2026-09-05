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

function mixHex(foreground: string, background: string, opacity: number): string {
  const fg = hexToRgb(foreground);
  const bg = hexToRgb(background);
  return `#${fg.map((channel, index) =>
    Math.round(channel * opacity + bg[index]! * (1 - opacity)).toString(16).padStart(2, "0"),
  ).join("")}`;
}

function compositeTint(value: string, vars: Record<string, string>, background: string): string {
  const resolved = value.replace(/var\((--[^)]+)\)/g, (_, token: string) => vars[token]!);
  const mix = resolved.match(/^color-mix\(in srgb, (#[a-f\d]{6}) (\d+)%, transparent\)$/i);
  if (mix) return mixHex(mix[1]!, background, Number(mix[2]) / 100);
  const rgba = resolved.match(/^rgba\(([^)]+)\)$/);
  if (rgba) {
    const [r, g, b, opacity] = rgba[1]!.split(",").map(Number);
    const hex = `#${[r!, g!, b!].map(c => c.toString(16).padStart(2, "0")).join("")}`;
    return mixHex(hex, background, opacity!);
  }
  throw new Error(`Unsupported theme tint: ${value}`);
}

describe("theme text and semantic contrast", () => {
  for (const theme of themes) {
    const vars = theme.vars;
    const surfaces = ["--bg-primary", "--bg-secondary", "--bg-surface", "--bg-elevated"];

    it(`${theme.id} keeps its text hierarchy readable on every base surface`, () => {
      for (const surface of surfaces) {
        let previous = Infinity;
        for (const token of ["--text-primary", "--text-secondary", "--text-muted", "--text-dim"]) {
          const ratio = contrastRatio(vars[token]!, vars[surface]!);
          expect(ratio, `${token} on ${surface}`).toBeGreaterThanOrEqual(4.5);
          expect(ratio, `${token} hierarchy on ${surface}`).toBeLessThan(previous);
          previous = ratio;
        }
      }
    });

    it(`${theme.id} keeps status, priority and model labels readable on tinted badges`, () => {
      for (const [token, color] of Object.entries(vars)) {
        if (!/^--(status|priority|model)-/.test(token)) continue;
        // Activity status pills use up to 18% ink; model/priority chips use
        // subtler tints. Composite the transparent chip over its host surface.
        const opacity = token.startsWith("--status-") ? 0.18 : 0.12;
        for (const surface of surfaces) {
          expect(contrastRatio(color, mixHex(color, vars[surface]!, opacity)),
            `${token} badge on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`${theme.id} keeps filled actions readable in both normal and hover states`, () => {
      for (const background of ["--accent", "--accent-dark"]) {
        expect(contrastRatio(vars["--text-on-accent"]!, vars[background]!), background)
          .toBeGreaterThanOrEqual(4.5);
      }
      for (const background of ["--status-success", "--danger-color"]) {
        expect(contrastRatio(vars["--text-on-status"]!, vars[background]!), background)
          .toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(vars["--text-on-status"]!,
        mixHex(vars["--status-success"]!, vars["--text-primary"]!, 0.82)), "success hover")
        .toBeGreaterThanOrEqual(4.5);
    });

    it(`${theme.id} keeps semantic panel text readable on its actual tints`, () => {
      for (const kind of ["tool", "thinking", "success", "danger", "warning", "info"]) {
        const expandable = kind === "tool" || kind === "thinking";
        const color = vars[`--${kind}-${expandable ? "accent" : "color"}`]!;
        for (const suffix of expandable ? ["bg", "bg-hover"] : ["bg"]) {
          const token = `--${kind}-${suffix}`;
          for (const surface of surfaces) {
            const background = compositeTint(vars[token]!, vars, vars[surface]!);
            expect(contrastRatio(color, background), `${token} on ${surface}`)
              .toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    });
  }
});

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

});

describe("leader icon contrast", () => {
  it("uses each theme's accent with strong contrast on leader surfaces", () => {
    for (const theme of themes) {
      const accent = theme.vars["--accent"];
      const surface = theme.vars["--bg-surface"];
      const elevated = theme.vars["--bg-elevated"];
      if (!accent || !surface || !elevated) {
        throw new Error(`${theme.id} is missing leader icon palette tokens`);
      }

      expect(theme.vars["--leader-icon-color"], theme.id).toBe("var(--accent)");
      expect(contrastRatio(accent, surface), `${theme.id} surface contrast`)
        .toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(accent, elevated), `${theme.id} elevated contrast`)
        .toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("permanent skins", () => {
  it("replaces the glow-heavy skins with two restrained light skins", () => {
    expect(skinThemes.map((s) => s.id)).toEqual([
      "daybook",
      "ink",
      "blueprint",
      "porcelain",
      "obsidian",
      "lavender-field",
    ]);
    expect(themeMap["glass"]).toBeUndefined();
    expect(themeMap["nocturne"]).toBeUndefined();
  });

  it("pairs every dark theme on the left with a light theme on the right", () => {
    expect(themes).toHaveLength(12);
    for (let index = 0; index < themes.length; index += 2) {
      expect(themes[index]?.tone, `row ${index / 2 + 1} left`).toBe("dark");
      expect(themes[index + 1]?.tone, `row ${index / 2 + 1} right`).toBe("light");
    }
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
