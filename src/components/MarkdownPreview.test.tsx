import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  MarkdownPreview,
  parseMarkdownPreviewBlocks,
} from "./MarkdownPreview.tsx";

describe("parseMarkdownPreviewBlocks", () => {
  it("preserves legacy markdown block types with source ranges", () => {
    const content = [
      "# Title",
      "",
      "Body **bold** and `code`",
      "- first",
      "- second",
      "1. ordered",
      "2. list",
      "> quote",
      "---",
      "```ts",
      'const tag = "<x>";',
      "```",
    ].join("\n");

    const blocks = parseMarkdownPreviewBlocks(content);

    expect(blocks.map((block) => block.type)).toEqual([
      "heading",
      "spacer",
      "paragraph",
      "list",
      "list",
      "blockquote",
      "rule",
      "code",
    ]);
    expect(blocks[0]).toMatchObject({
      type: "heading",
      text: "Title",
      level: 1,
      from: 0,
      to: "# Title".length,
    });
    expect(blocks[3]).toMatchObject({
      type: "list",
      ordered: false,
      from: content.indexOf("- first"),
      to: content.indexOf("- second") + "- second".length,
    });
    expect(blocks[4]).toMatchObject({
      type: "list",
      ordered: true,
      from: content.indexOf("1. ordered"),
      to: content.indexOf("2. list") + "2. list".length,
    });
    expect(blocks[7]).toMatchObject({
      type: "code",
      text: 'const tag = "<x>";',
      from: content.indexOf("```ts"),
      to: content.length,
    });
  });
});

describe("MarkdownPreview", () => {
  it("renders markdown as React elements without injecting HTML", () => {
    const { container } = render(
      <MarkdownPreview
        content={[
          "# Hello <script>alert(1)</script>",
          "",
          "A **bold** word, an *emphasis*, and `code`.",
          "<img src=x onerror=alert(1)>",
        ].join("\n")}
      />,
    );

    expect(container.querySelector(".md-preview")).not.toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(container.querySelector(".md-bold")).toHaveTextContent("bold");
    expect(container.querySelector(".md-inline-code")).toHaveTextContent("code");
  });

  it("emits block source range attributes for split-view affordances", () => {
    const { container } = render(
      <MarkdownPreview content={"# Title\n\nParagraph"} />,
    );

    const heading = container.querySelector(".md-h1");
    const paragraph = container.querySelector(".md-p");

    expect(heading).toHaveAttribute("data-md-block-id", "heading-0-7");
    expect(heading).toHaveAttribute("data-md-source-from", "0");
    expect(heading).toHaveAttribute("data-md-source-to", "7");
    expect(paragraph).toHaveAttribute("data-md-source-from", "9");
    expect(paragraph).toHaveAttribute("data-md-source-to", "18");
  });
});
