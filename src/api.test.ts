import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAuthToken,
  attachProject,
  checkProjectGit,
  createProject,
  encodePath,
  getAuthToken,
  getHarnessReadiness,
  getProjectTree,
  listProjects,
  rebindProject,
  updateProjectContext,
} from "./api.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("API client boundary", () => {
  beforeEach(() => {
    clearAuthToken();
    vi.restoreAllMocks();
  });

  it("coalesces concurrent token bootstrap requests and caches the result", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ token: "secret" }));

    await expect(Promise.all([getAuthToken(), getAuthToken()])).resolves.toEqual(["secret", "secret"]);
    await expect(getAuthToken()).resolves.toBe("secret");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/token");
  });

  it.each([
    ["HTTP 502", () => Promise.resolve(jsonResponse({}, 502))],
    ["network failure", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("retries token bootstrap after %s so Git checks can recover", async (_label, fail) => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(fail)
      .mockResolvedValueOnce(jsonResponse({ token: "recovered" }))
      .mockResolvedValueOnce(jsonResponse({ isRepository: true }));

    await expect(checkProjectGit("/repo")).rejects.toThrow();
    await expect(checkProjectGit("/repo")).resolves.toEqual({ isRepository: true });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/auth/token", "/api/auth/token", "/api/projects/git-status",
    ]);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/projects/git-status", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer recovered" }),
    }));
  });

  it.each(["resolve", "reject"])("ignores an invalidated bootstrap when it later %ss", async (outcome) => {
    let resolveOld!: (response: Response) => void;
    let rejectOld!: (error: Error) => void;
    const oldResponse = new Promise<Response>((resolve, reject) => {
      resolveOld = resolve;
      rejectOld = reject;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(oldResponse)
      .mockResolvedValueOnce(jsonResponse({ token: "new" }));

    const oldRequest = getAuthToken();
    clearAuthToken();
    await expect(getAuthToken()).resolves.toBe("new");
    if (outcome === "resolve") {
      resolveOld(jsonResponse({ token: "old" }));
      await expect(oldRequest).resolves.toBe("old");
    } else {
      rejectOld(new Error("offline"));
      await expect(oldRequest).rejects.toThrow("offline");
    }
    await expect(getAuthToken()).resolves.toBe("new");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends authenticated JSON requests without losing method or body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ token: "secret" }))
      .mockResolvedValueOnce(jsonResponse({ id: "p1", path: "/repo" }));

    await createProject("Demo", "/repo");

    expect(fetchMock).toHaveBeenLastCalledWith("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Demo", path: "/repo" }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret",
      },
    });
  });

  it("checks Git status and sends an explicit initialization choice", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ token: "secret" }))
      .mockResolvedValueOnce(jsonResponse({ isRepository: false }))
      .mockResolvedValueOnce(jsonResponse({ id: "p1", path: "/repo" }));

    await expect(checkProjectGit("/repo")).resolves.toEqual({ isRepository: false });
    await createProject("Demo", "/repo", "initialize");

    expect(fetchMock.mock.calls.slice(1)).toEqual([
      ["/api/projects/git-status", expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ path: "/repo" }),
      })],
      ["/api/projects", expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Demo", path: "/repo", gitAction: "initialize" }),
      })],
    ]);
  });

  it("sends explicit workspace attachment and rebind operations", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ token: "secret" }))
      .mockImplementation(async () => jsonResponse({ id: "workspace-1", path: "/repo" }));

    await attachProject("workspace-1", "/repo-copy");
    await rebindProject("workspace-1", "/repo-moved");

    expect(fetchMock.mock.calls.slice(1)).toEqual([
      ["/api/projects/attach", expect.objectContaining({ method: "POST",
        body: JSON.stringify({ workspaceId: "workspace-1", path: "/repo-copy" }) })],
      ["/api/projects/rebind", expect.objectContaining({ method: "POST",
        body: JSON.stringify({ workspaceId: "workspace-1", path: "/repo-moved" }) })],
    ]);
  });

  it("uses the readiness refresh query only when explicitly requested", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ token: "secret" }))
      .mockImplementation(async () => jsonResponse({ ready: true, harnesses: [] }));

    await getHarnessReadiness();
    await getHarnessReadiness(true);

    expect(fetchMock.mock.calls.slice(1).map(([url]) => url)).toEqual([
      "/api/readiness",
      "/api/readiness?refresh=1",
    ]);
  });

  it("base64url-encodes Unicode paths and sends the requested tree depth", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ token: "secret" }))
      .mockResolvedValueOnce(jsonResponse({ name: "repo", path: "/tmp/répo", type: "directory", children: [] }));

    const id = encodePath("/tmp/répo");
    await getProjectTree(id, 4);

    const requestUrl = String(fetchMock.mock.calls[1]?.[0]);
    expect(id).toBe("L3RtcC9yw6lwbw");
    expect(requestUrl).toBe("/api/projects/L3RtcC9yw6lwbw/tree?depth=4");
  });

  it("surfaces the response status and body for failed calls", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ token: "secret" }))
      .mockResolvedValueOnce(new Response("project unavailable", { status: 503 }));

    await expect(listProjects()).rejects.toThrow("API error 503: project unavailable");
  });

  it("serializes context updates through the same authenticated helper", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ token: "secret" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await updateProjectContext("p/1", "# Context");

    expect(fetchMock).toHaveBeenLastCalledWith("/api/projects/p/1/context", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ content: "# Context" }),
    }));
  });
});
