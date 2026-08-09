import { describe, expect, it } from "vitest";

import { joinSelectedChunks, parseMessageChunks } from "./message-chunks.ts";

describe("parseMessageChunks", () => {
  it("groups markdown into copyable semantic chunks", () => {
    const chunks = parseMessageChunks([
      "# Plan",
      "",
      "Intro line one",
      "intro line two",
      "",
      "- first",
      "- second",
      "",
      "```ts",
      "const answer = 42;",
      "```",
    ].join("\n"));

    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "heading",
      "paragraph",
      "list",
      "code",
    ]);
    expect(chunks[1]?.rawText).toBe("Intro line one\nintro line two");
    expect(chunks[2]?.rawText).toBe("- first\n- second");
    expect(chunks[3]?.rawText).toBe("```ts\nconst answer = 42;\n```");
  });

  it("joins selected chunks in source order with markdown spacing", () => {
    const chunks = parseMessageChunks("One\n\nTwo\n\nThree");
    const selected = new Set([chunks[0]?.id ?? "", chunks[2]?.id ?? ""]);

    expect(joinSelectedChunks(chunks, selected)).toBe("One\n\nThree");
  });
});
