import {
  memo,
  useMemo,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  parseMarkdownPreviewBlocks,
  type MarkdownPreviewBlock,
} from "../markdown/markdown-preview-blocks.ts";

export { parseMarkdownPreviewBlocks };
export type { MarkdownPreviewBlock };

const INLINE_TOKEN_RE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  INLINE_TOKEN_RE.lastIndex = 0;
  while ((match = INLINE_TOKEN_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    const raw = match[0];
    const key = `${keyPrefix}-${match.index}`;
    if (raw.startsWith("`")) {
      parts.push(
        <code key={key} className="md-inline-code">
          {raw.slice(1, -1)}
        </code>,
      );
    } else if (raw.startsWith("**")) {
      parts.push(
        <strong key={key} className="md-bold">
          {raw.slice(2, -2)}
        </strong>,
      );
    } else {
      parts.push(<em key={key}>{raw.slice(1, -1)}</em>);
    }

    lastIndex = INLINE_TOKEN_RE.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : [text];
}

function sourceRangeAttrs(block: { id: string; from: number; to: number }) {
  return {
    "data-md-block-id": block.id,
    "data-md-source-from": block.from,
    "data-md-source-to": block.to,
  };
}

function renderBlock(block: MarkdownPreviewBlock): ReactElement {
  switch (block.type) {
    case "heading": {
      const displayLevel = Math.min(block.level, 3);
      const className =
        displayLevel === 1 ? "md-h1" : displayLevel === 2 ? "md-h2" : "md-h3";
      const children = renderInline(block.text, block.id);
      if (displayLevel === 1) {
        return (
          <h3 key={block.id} className={className} {...sourceRangeAttrs(block)}>
            {children}
          </h3>
        );
      }
      if (displayLevel === 2) {
        return (
          <h4 key={block.id} className={className} {...sourceRangeAttrs(block)}>
            {children}
          </h4>
        );
      }
      return (
        <h5 key={block.id} className={className} {...sourceRangeAttrs(block)}>
          {children}
        </h5>
      );
    }

    case "list": {
      const ListTag = block.ordered ? "ol" : "ul";
      return (
        <ListTag key={block.id} className="md-list" {...sourceRangeAttrs(block)}>
          {block.items.map((item) => (
            <li
              key={item.id}
              data-md-item-id={item.id}
              data-md-source-from={item.from}
              data-md-source-to={item.to}
            >
              {renderInline(item.text, item.id)}
            </li>
          ))}
        </ListTag>
      );
    }

    case "code":
      return (
        <pre key={block.id} className="md-code-block" {...sourceRangeAttrs(block)}>
          <code>{block.text}</code>
        </pre>
      );

    case "blockquote":
      return (
        <blockquote key={block.id} className="md-blockquote" {...sourceRangeAttrs(block)}>
          {renderInline(block.text, block.id)}
        </blockquote>
      );

    case "rule":
      return <hr key={block.id} className="md-hr" {...sourceRangeAttrs(block)} />;

    case "spacer":
      return (
        <div
          key={block.id}
          className="md-spacer"
          aria-hidden="true"
          {...sourceRangeAttrs(block)}
        />
      );

    case "paragraph":
    default:
      return (
        <p key={block.id} className="md-p" {...sourceRangeAttrs(block)}>
          {renderInline(block.text, block.id)}
        </p>
      );
  }
}

export interface MarkdownPreviewProps
  extends Pick<HTMLAttributes<HTMLDivElement>, "onMouseDown" | "onDoubleClick"> {
  content: string;
  className?: string;
}

export const MarkdownPreview = memo(function MarkdownPreview({
  content,
  className = "md-preview",
  onMouseDown,
  onDoubleClick,
}: MarkdownPreviewProps) {
  const blocks = useMemo(() => parseMarkdownPreviewBlocks(content), [content]);

  return (
    <div
      className={className}
      data-no-drag
      data-scroll-capture
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
    >
      {blocks.map(renderBlock)}
    </div>
  );
});
