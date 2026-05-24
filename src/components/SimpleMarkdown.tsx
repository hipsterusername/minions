/**
 * Lightweight inline markdown renderer for message bubbles.
 * Handles: **bold**, *italic*, `code`, ```code blocks```, numbered/bulleted lists.
 * Does NOT use dangerouslySetInnerHTML — returns React elements.
 */

import { memo, useMemo } from "react";
import type { ReactElement } from "react";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Parse inline formatting within a single line */
function renderInline(text: string): (string | ReactElement)[] {
  const parts: (string | ReactElement)[] = [];
  // Match: `code`, **bold**, *italic*
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const raw = match[0];
    if (raw.startsWith("`")) {
      parts.push(
        <code
          key={match.index}
          style={{
            padding: "1px 5px",
            borderRadius: 3,
            background: "var(--code-bg)",
            fontFamily: "var(--font-mono)",
            fontSize: "0.9em",
            color: "var(--accent)",
          }}
        >
          {raw.slice(1, -1)}
        </code>,
      );
    } else if (raw.startsWith("**")) {
      parts.push(
        <strong key={match.index} style={{ fontWeight: 600, color: "var(--text-primary)" }}>
          {raw.slice(2, -2)}
        </strong>,
      );
    } else if (raw.startsWith("*")) {
      parts.push(
        <em key={match.index} style={{ fontStyle: "italic" }}>
          {raw.slice(1, -1)}
        </em>,
      );
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.length > 0 ? parts : [text];
}

interface Block {
  type: "paragraph" | "heading" | "list-item" | "code-block" | "blank";
  content: string;
  level?: number; // heading level
}

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let codeBlock: string[] | null = null;

  for (const line of lines) {
    // Code fences
    if (line.trimStart().startsWith("```")) {
      if (codeBlock !== null) {
        blocks.push({ type: "code-block", content: codeBlock.join("\n") });
        codeBlock = null;
      } else {
        codeBlock = [];
      }
      continue;
    }
    if (codeBlock !== null) {
      codeBlock.push(line);
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch && headingMatch[1] !== undefined && headingMatch[2] !== undefined) {
      blocks.push({ type: "heading", content: headingMatch[2], level: headingMatch[1].length });
      continue;
    }

    // List items (-, *, •, 1., 2))
    const listMatch = line.match(/^\s*(?:[-*•]\s+|\d+[.)]\s+)(.+)/);
    if (listMatch && listMatch[1] !== undefined) {
      blocks.push({ type: "list-item", content: listMatch[1] });
      continue;
    }

    // Blank lines
    if (line.trim() === "") {
      blocks.push({ type: "blank", content: "" });
      continue;
    }

    // Regular paragraph
    blocks.push({ type: "paragraph", content: line });
  }

  // Close unclosed code block
  if (codeBlock !== null) {
    blocks.push({ type: "code-block", content: codeBlock.join("\n") });
  }

  return blocks;
}

export const SimpleMarkdown = memo(function SimpleMarkdown({ text }: { text: string }) {
  const renderedBlocks = useMemo(
    () =>
      parseBlocks(text).map((block, i) => {
        switch (block.type) {
          case "heading":
            return (
              <div
                key={i}
                style={{
                  fontWeight: 700,
                  fontSize: block.level === 1 ? 14 : block.level === 2 ? 13 : 12,
                  color: "var(--text-primary)",
                  marginTop: i > 0 ? 8 : 0,
                  marginBottom: 2,
                  lineHeight: 1.4,
                }}
              >
                {renderInline(block.content)}
              </div>
            );
          case "list-item":
            return (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: 6,
                  paddingLeft: 4,
                  lineHeight: 1.6,
                }}
              >
                <span
                  style={{
                    color: "var(--accent)",
                    flexShrink: 0,
                    fontSize: 10,
                    marginTop: 3,
                  }}
                >
                  •
                </span>
                <span>{renderInline(block.content)}</span>
              </div>
            );
          case "code-block":
            return (
              <pre
                key={i}
                style={{
                  margin: "4px 0",
                  padding: "8px 10px",
                  borderRadius: 6,
                  background: "var(--bg-primary)",
                  border: "1px solid var(--border-default)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  lineHeight: 1.5,
                  overflowX: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  color: "var(--accent)",
                }}
              >
                {escapeHtml(block.content)}
              </pre>
            );
          case "blank":
            return <div key={i} style={{ height: 4 }} />;
          case "paragraph":
          default:
            return (
              <div key={i} style={{ lineHeight: 1.6 }}>
                {renderInline(block.content)}
              </div>
            );
        }
      }),
    [text],
  );

  return <>{renderedBlocks}</>;
});
