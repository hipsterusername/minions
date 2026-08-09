import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAuthToken,
  attachProject,
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
    expect(requestUrl).toMatch(/^\/api\/projects\/[^/]+\/tree\?depth=4$/);
    expect(id).not.toContain("+");
    expect(id).not.toContain("=");
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
