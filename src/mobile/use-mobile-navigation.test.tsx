import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useMobileNavigation } from "./use-mobile-navigation.ts";

const project = { id: "alpha", name: "Alpha", path: "/work/alpha" };
afterEach(() => window.history.replaceState(null, "", "/"));

it("uses browser Back and Forward for session views and returns directly to project Activity", async () => {
  window.history.replaceState(null, "", "/m");
  const { result } = renderHook(() => useMobileNavigation());
  act(() => result.current.navigate({ project, screen: "activity", sessionKey: null, view: "chat" }));
  act(() => result.current.navigate({ project, screen: "chat", sessionKey: "one", view: "chat" }));
  act(() => result.current.navigate({ project, screen: "chat", sessionKey: "one", view: "changes" }));
  act(() => window.history.back());
  await waitFor(() => expect(result.current.route.view).toBe("chat"));
  expect(result.current.route.sessionKey).toBe("one");
  expect(result.current.route.project).toEqual(project);
  act(() => window.history.forward());
  await waitFor(() => expect(result.current.route.view).toBe("changes"));
  act(() => result.current.backToActivity());
  await waitFor(() => expect(result.current.route.screen).toBe("activity"));
  expect(new URL(window.location.href).searchParams.get("project")).toBe("alpha");
  expect(new URL(window.location.href).searchParams.has("session")).toBe(false);
});

it("gives an initial review notification a local Activity return destination", () => {
  window.history.replaceState(null, "", "/m?session=one&review=1");
  const { result } = renderHook(() => useMobileNavigation());
  expect(result.current.route.view).toBe("changes");
  act(() => result.current.navigate({ ...result.current.route, project }, true));
  const length = window.history.length;
  act(() => result.current.backToActivity());
  expect(result.current.route).toEqual({ project, screen: "activity", sessionKey: null, view: "chat" });
  expect(window.history.length).toBe(length);
});

it("does not add history entries when selecting the current view", () => {
  window.history.replaceState(null, "", "/m?session=one");
  const { result } = renderHook(() => useMobileNavigation());
  const length = window.history.length;
  act(() => result.current.navigate(result.current.route));
  expect(window.history.length).toBe(length);
});

it("closes graph to Work through browser Back, supports Forward, and closes without another entry", async () => {
  window.history.replaceState(null, "", "/m?session=one&view=work");
  const { result } = renderHook(() => useMobileNavigation());
  act(() => result.current.navigate({ ...result.current.route, view: "graph" }));
  expect(new URL(window.location.href).searchParams.get("view")).toBe("graph");
  act(() => window.history.back());
  await waitFor(() => expect(result.current.route.view).toBe("work"));
  act(() => window.history.forward());
  await waitFor(() => expect(result.current.route.view).toBe("graph"));
  const length = window.history.length;
  act(() => result.current.closeGraph());
  await waitFor(() => expect(result.current.route.view).toBe("work"));
  expect(window.history.length).toBe(length);
});

it("closes a direct graph link locally to Work", () => {
  window.history.replaceState(null, "", "/m?session=one&view=graph");
  const { result } = renderHook(() => useMobileNavigation());
  expect(result.current.route.view).toBe("graph");
  const length = window.history.length;
  act(() => result.current.closeGraph());
  expect(result.current.route.view).toBe("work");
  expect(window.history.length).toBe(length);
});
