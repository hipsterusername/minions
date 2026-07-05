import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import {
  buildMobileRedirectUrl,
  readViewParam,
  selectRootView,
  type ViewPreference,
} from "./view-route.ts";

// Route gate: the mobile Leader Console (`/m*`) and the desktop canvas are
// each code-split so visiting one never downloads the other's bundle. The
// mobile companion in particular must stay lightweight on phone networks.
//
// On a small screen the mobile shell is the *default*: a visitor landing on a
// desktop URL is auto-redirected onto the canonical `/m` route (so the app,
// service worker, and manifest all agree). A `?view=` override — remembered in
// localStorage — is the manual escape hatch in both directions.

const VIEW_PREF_KEY = "minions:view";

function resolveViewPreference(): ViewPreference | null {
  const fromQuery = readViewParam(window.location.search);
  if (fromQuery) {
    try {
      window.localStorage.setItem(VIEW_PREF_KEY, fromQuery);
    } catch {
      // Storage can throw in private mode / disabled-cookie contexts; the
      // override still applies for this load, it just won't persist.
    }
    return fromQuery;
  }

  try {
    const stored = window.localStorage.getItem(VIEW_PREF_KEY);
    return stored === "mobile" || stored === "desktop" ? stored : null;
  } catch {
    return null;
  }
}

const view = selectRootView({
  pathname: window.location.pathname,
  viewportWidth: window.innerWidth,
  preference: resolveViewPreference(),
});

if (view === "mobile" && !window.location.pathname.startsWith("/m")) {
  // Small-screen visitor hit a desktop URL: hop onto `/m` before rendering so
  // we never download the desktop bundle. `replace` keeps the redirect out of
  // history, so Back doesn't bounce them between shells.
  window.location.replace(buildMobileRedirectUrl(window.location));
} else {
  const RootApp = lazy(() =>
    view === "mobile" ? import("./mobile/MobileApp.tsx") : import("./App.tsx"),
  );

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Suspense fallback={null}>
        <RootApp />
      </Suspense>
    </StrictMode>,
  );
}
