import { useCallback, useEffect, useRef, useState } from "react";

export interface ProjectScope { id: string; path: string; name: string }
export type SessionView = "chat" | "work" | "changes" | "graph";
export interface MobileRoute {
  project: ProjectScope | null;
  screen: "activity" | "chat" | "launch" | "settings";
  sessionKey: string | null;
  view: SessionView;
}

export function mobileRouteFromUrl(url: string): MobileRoute {
  const parsed = new URL(url, window.location.origin);
  const sessionKey = parsed.searchParams.get("session");
  const view = parsed.searchParams.get("view");
  return {
    project: null,
    screen: sessionKey ? "chat" : view === "launch" || view === "settings" ? view : "activity",
    sessionKey,
    view: parsed.searchParams.get("review") === "1" ? "changes" : view === "work" || view === "changes" || view === "graph" ? view : "chat",
  };
}

function routeUrl(route: MobileRoute): string {
  const url = new URL(window.location.href);
  for (const key of ["session", "review", "view", "project"]) url.searchParams.delete(key);
  if (route.project) url.searchParams.set("project", route.project.id);
  if (route.screen === "chat" && route.sessionKey) {
    url.searchParams.set("session", route.sessionKey);
    if (route.view === "changes") url.searchParams.set("review", "1");
    else if (route.view !== "chat") url.searchParams.set("view", route.view);
  } else if (route.screen !== "activity") url.searchParams.set("view", route.screen);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function useMobileNavigation() {
  const [route, setRoute] = useState<MobileRoute>(() => mobileRouteFromUrl(window.location.href));
  // Project metadata is resolved from current server data by MobileApp, never
  // trusted from browser history. Retaining it by ID makes Back synchronous.
  const owner = useRef(`mobile-${Math.random().toString(36).slice(2)}`);
  const index = useRef(0);
  const entries = useRef(new Map<number, MobileRoute>([[0, route]]));
  useEffect(() => {
    window.history.replaceState({ ...window.history.state, mobileNavigation: { owner: owner.current, index: 0 } }, "");
  }, []);
  const [projects] = useState(() => new Map<string, ProjectScope>());
  const navigate = useCallback((next: MobileRoute, replace = false) => {
    if (next.project) projects.set(next.project.id, next.project);
    const url = routeUrl(next);
    const sameUrl = url === `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (!replace && !sameUrl) {
      for (const key of entries.current.keys()) if (key > index.current) entries.current.delete(key);
      index.current += 1;
    }
    entries.current.set(index.current, next);
    window.history[replace || sameUrl ? "replaceState" : "pushState"](
      { ...window.history.state, mobileNavigation: { owner: owner.current, index: index.current } }, "", url);
    setRoute(next);
  }, [projects]);
  useEffect(() => {
    const onPop = () => {
      const entry = window.history.state?.mobileNavigation;
      if (entry?.owner === owner.current) index.current = entry.index;
      const next = mobileRouteFromUrl(window.location.href);
      const projectId = new URL(window.location.href).searchParams.get("project");
      next.project = projectId ? projects.get(projectId) ?? null : null;
      setRoute(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [projects]);
  const backToActivity = useCallback(() => {
    for (let previous = index.current - 1; previous >= 0; previous -= 1) {
      const candidate = entries.current.get(previous);
      if (candidate?.screen === "activity" && candidate.project?.id === route.project?.id) {
        window.history.go(previous - index.current);
        return;
      }
    }
    // A notification can be the first entry in this tab. Give it a local home
    // without traversing out of the app or silently selecting another session.
    navigate({ ...route, screen: "activity", sessionKey: null, view: "chat" }, true);
  }, [navigate, route]);
  const closeGraph = useCallback(() => {
    const previous = entries.current.get(index.current - 1);
    if (previous?.screen === "chat" && previous.view === "work"
      && previous.sessionKey === route.sessionKey && previous.project?.id === route.project?.id) {
      window.history.back();
    } else {
      // A direct graph link has no local Work entry to return to.
      navigate({ ...route, view: "work" }, true);
    }
  }, [navigate, route]);
  return { route, navigate, backToActivity, closeGraph };
}
