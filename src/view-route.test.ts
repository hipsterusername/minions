import { describe, expect, it } from "vitest";

import {
  MOBILE_BREAKPOINT_PX,
  buildMobileRedirectUrl,
  isSmallViewport,
  readViewParam,
  selectRootView,
} from "./view-route.ts";

describe("isSmallViewport", () => {
  it("treats widths at or below the breakpoint as small", () => {
    expect(isSmallViewport(320)).toBe(true);
    expect(isSmallViewport(MOBILE_BREAKPOINT_PX)).toBe(true);
  });

  it("treats wider viewports as not small", () => {
    expect(isSmallViewport(MOBILE_BREAKPOINT_PX + 1)).toBe(false);
    expect(isSmallViewport(1440)).toBe(false);
  });

  it("ignores a zero/unknown width rather than guessing mobile", () => {
    // jsdom-less / SSR contexts can report 0; we must not force mobile there.
    expect(isSmallViewport(0)).toBe(false);
  });
});

describe("selectRootView", () => {
  it("defaults a small-screen visitor on a desktop URL to mobile", () => {
    expect(
      selectRootView({ pathname: "/", viewportWidth: 390 }),
    ).toBe("mobile");
  });

  it("keeps a large-screen visitor on desktop", () => {
    expect(
      selectRootView({ pathname: "/", viewportWidth: 1440 }),
    ).toBe("desktop");
  });

  it("always serves mobile for an explicit /m route, even on a large screen", () => {
    expect(
      selectRootView({ pathname: "/m", viewportWidth: 1920 }),
    ).toBe("mobile");
    expect(
      selectRootView({ pathname: "/m?session=s-1", viewportWidth: 1920 }),
    ).toBe("mobile");
  });

  it("honors a desktop preference on a small screen (escape hatch)", () => {
    expect(
      selectRootView({ pathname: "/", viewportWidth: 390, preference: "desktop" }),
    ).toBe("desktop");
  });

  it("honors a mobile preference on a large screen (escape hatch)", () => {
    expect(
      selectRootView({ pathname: "/", viewportWidth: 1440, preference: "mobile" }),
    ).toBe("mobile");
  });

  it("lets the explicit /m path override a desktop preference", () => {
    expect(
      selectRootView({ pathname: "/m", viewportWidth: 390, preference: "desktop" }),
    ).toBe("mobile");
  });

  it("ignores a null preference and falls back to width", () => {
    expect(
      selectRootView({ pathname: "/", viewportWidth: 390, preference: null }),
    ).toBe("mobile");
  });
});

describe("readViewParam", () => {
  it("parses a mobile override", () => {
    expect(readViewParam("?view=mobile")).toBe("mobile");
  });

  it("parses a desktop override", () => {
    expect(readViewParam("?view=desktop")).toBe("desktop");
  });

  it("works without a leading question mark", () => {
    expect(readViewParam("view=mobile")).toBe("mobile");
  });

  it("returns null for missing or invalid values", () => {
    expect(readViewParam("")).toBeNull();
    expect(readViewParam("?session=s-1")).toBeNull();
    expect(readViewParam("?view=tablet")).toBeNull();
  });
});

describe("buildMobileRedirectUrl", () => {
  it("prefixes /m and preserves query + hash", () => {
    expect(
      buildMobileRedirectUrl({ search: "?session=s-1&review=1", hash: "#top" }),
    ).toBe("/m?session=s-1&review=1#top");
  });

  it("produces a bare /m when there is no query or hash", () => {
    expect(buildMobileRedirectUrl({ search: "", hash: "" })).toBe("/m");
  });
});
