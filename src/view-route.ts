/**
 * Root-view selection.
 *
 * The mobile Leader Console lives under the `/m*` route and the desktop canvas
 * lives at `/`. This module owns the *pure* decision of which one a visitor
 * should land on, so the choice is unit-testable and the composition root
 * (`main.tsx`) stays a thin boundary that just reads `window` and acts.
 *
 * Policy (matches docs/mobile-concept.md §"Shell strategy" and
 * docs/mobile-experience-spec.md §9.1 — "device-detected auto-redirect to
 * `/m`, with a manual escape hatch"):
 *   - An explicit `/m*` path is always the mobile app.
 *   - An explicit user preference (`?view=mobile|desktop`, persisted) wins next.
 *   - Otherwise small viewports (≤ breakpoint) default to mobile, large ones
 *     to desktop.
 */

/** Viewports at or below this width default to the mobile shell. */
export const MOBILE_BREAKPOINT_PX = 768;

export type RootView = "mobile" | "desktop";

/** An explicit user override, set via `?view=` and remembered across visits. */
export type ViewPreference = RootView;

export interface RootViewInput {
  /** `window.location.pathname`. */
  pathname: string;
  /** `window.innerWidth`. */
  viewportWidth: number;
  /** Sticky override from the query string / localStorage, if any. */
  preference?: ViewPreference | null;
}

/** True when the viewport is narrow enough to default to the mobile shell. */
export function isSmallViewport(viewportWidth: number): boolean {
  return viewportWidth > 0 && viewportWidth <= MOBILE_BREAKPOINT_PX;
}

/**
 * Decide which root app bundle to load. Pure: no `window` access, no I/O.
 */
export function selectRootView({
  pathname,
  viewportWidth,
  preference,
}: RootViewInput): RootView {
  // An explicit mobile route is the strongest signal and always wins, so the
  // redirect below can never loop back on itself.
  if (pathname.startsWith("/m")) return "mobile";

  // A user who picked a side keeps it — this is the manual escape hatch in
  // both directions (e.g. forcing the canvas on a phone, or mobile on a laptop).
  if (preference === "desktop") return "desktop";
  if (preference === "mobile") return "mobile";

  return isSmallViewport(viewportWidth) ? "mobile" : "desktop";
}

/**
 * Parse a `?view=` override into a preference, or `null` when absent/invalid.
 * Accepts a raw `location.search` string (with or without the leading `?`).
 */
export function readViewParam(search: string): ViewPreference | null {
  const value = new URLSearchParams(search).get("view");
  return value === "mobile" || value === "desktop" ? value : null;
}

/**
 * Build the `/m` URL for an auto-redirect, preserving the query + hash so deep
 * links (e.g. `?session=...&review=1`) survive the hop onto the mobile route.
 */
export function buildMobileRedirectUrl(location: {
  search: string;
  hash: string;
}): string {
  return `/m${location.search}${location.hash}`;
}
