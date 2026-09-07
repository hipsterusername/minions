import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatLinkContext } from "./ChatLink.tsx";
import { SimpleMarkdown } from "./SimpleMarkdown.tsx";

function renderMessage(text: string, onClick = vi.fn()) {
  render(<ChatLinkContext.Provider value={{ project: "workspace", cwd: "/repo/worktree" }}>
    <div onClick={onClick}><SimpleMarkdown text={text} /></div>
  </ChatLinkContext.Provider>);
}

describe("chat hyperlinks", () => {
  it("opens web links in a separate tab without selecting the message", () => {
    const select = vi.fn();
    renderMessage("Read [**the docs**](https://example.com/docs_(new)) now.", select);
    const link = screen.getByRole("link", { name: "the docs" });
    expect(link).toHaveAttribute("href", "https://example.com/docs_(new)");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    fireEvent.click(link);
    expect(select).not.toHaveBeenCalled();
  });

  it.each([
    ["[source](src/app.ts:12:3)", "/repo/worktree/src/app.ts", "12"],
    ["[source](</repo/My Project/app.ts:42>)", "/repo/My Project/app.ts", "42"],
    ["[source](file:///repo/app.ts#L8-L10)", "/repo/app.ts", "8"],
    ["(source)[./src/app.ts#L7]", "/repo/worktree/./src/app.ts", "7"],
    ["[source](docs/a%20b.md)", "/repo/worktree/docs/a b.md", null],
  ])("routes %s to the authenticated file viewer", (text, path, line) => {
    renderMessage(text);
    const url = new URL(screen.getByRole("link", { name: "source" }).getAttribute("href")!, "http://localhost");
    expect(url.pathname).toBe("/file-view");
    expect(url.searchParams.get("project")).toBe("workspace");
    expect(url.searchParams.get("path")).toBe(path);
    expect(url.searchParams.get("line")).toBe(line);
  });

  it("leaves inline and fenced code literal and unfinished links readable", () => {
    renderMessage("`[inline](src/a.ts)`\n```md\n[fenced](src/b.ts)\n```\n[pending](src/");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("[inline](src/a.ts)")).toBeInTheDocument();
    expect(screen.getByText("[fenced](src/b.ts)")).toBeInTheDocument();
    expect(screen.getByText("[pending](src/")).toBeInTheDocument();
  });

  it("does not make unsafe schemes or malformed paths navigable", () => {
    renderMessage("[bad](javascript:alert(1)) [bad](data:text/html,evil) [bad](//other/path) [bad](file://remote/file) [bad](bad%ZZ.ts)");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
