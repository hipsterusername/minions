import { describe, expect, it } from "vitest";

import { createFilePathExtractor } from "./ProjectPanel.tsx";

describe("createFilePathExtractor", () => {
  it("caches extracted file paths by messages array reference", () => {
    const extract = createFilePathExtractor();
    const messages = [
      { role: "tool", toolName: "Read", content: "Read src/ProjectPanel.tsx" },
    ];

    const first = extract(messages);
    const second = extract(messages);

    expect(second).toBe(first);
    expect(second).toEqual(["src/ProjectPanel.tsx"]);
  });

  it("recomputes when the messages array reference changes", () => {
    const extract = createFilePathExtractor();
    const messages = [
      { role: "tool", toolName: "Read", content: "Read src/ProjectPanel.tsx" },
    ];
    const first = extract(messages);
    const nextMessages = [
      ...messages,
      { role: "tool", toolName: "Edit", content: "Edit src/components/ProjectTree.tsx" },
    ];

    const next = extract(nextMessages);

    expect(next).not.toBe(first);
    expect(next).toEqual(["src/ProjectPanel.tsx", "src/components/ProjectTree.tsx"]);
  });
});
