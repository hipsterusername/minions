import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import FileLinkView from "./FileLinkView.tsx";

vi.mock("./api.ts", () => ({ getAuthToken: vi.fn().mockResolvedValue("test-token") }));

afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });

describe("file link viewer", () => {
  it("loads the requested file with authentication and preserves source text and line targets", async () => {
    window.history.replaceState({}, "", "/file-view?project=workspace&path=%2Frepo%2Fa.ts&line=2");
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: "first\n<script>evil()</script>", truncated: true }) });
    vi.stubGlobal("fetch", fetch);
    render(<FileLinkView />);
    expect(await screen.findByText("<script>evil()</script>")).toHaveAttribute("id", "L2");
    expect(document.querySelector("script")).toBeNull();
    expect(fetch).toHaveBeenCalledWith("/api/projects/workspace/file?path=%2Frepo%2Fa.ts", expect.objectContaining({ headers: { Authorization: "Bearer test-token" } }));
    expect(screen.getByRole("status")).toHaveTextContent("512 KB");
  });

  it("renders Markdown files", async () => {
    window.history.replaceState({}, "", "/file-view?project=workspace&path=README.md");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: "# Documentation", truncated: false }) }));
    render(<FileLinkView />);
    expect(await screen.findByRole("heading", { name: "Documentation" })).toBeInTheDocument();
  });

  it("shows file access errors", async () => {
    window.history.replaceState({}, "", "/file-view?project=workspace&path=missing.ts");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: "File not found" }) }));
    render(<FileLinkView />);
    expect(await screen.findByRole("alert")).toHaveTextContent("File not found");
  });

  it("previews image blobs and releases their URLs on close", async () => {
    window.history.replaceState({}, "", "/file-view?project=workspace&path=picture.png");
    const create = vi.fn().mockReturnValue("blob:preview");
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["image"], { type: "image/png" }) }));
    const { unmount } = render(<FileLinkView />);
    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", "blob:preview"));
    unmount();
    expect(revoke).toHaveBeenCalledWith("blob:preview");
  });
});
