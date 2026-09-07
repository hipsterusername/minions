import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import type { DisplayMessage } from "../sdk-messages.ts";
import { SessionTranscript } from "./SessionTranscript.tsx";
import { ChatLinkScope } from "./ChatLink.tsx";

it("makes completed and streaming agent file links navigable in Activity", () => {
  render(<ChatLinkScope project="workspace" cwd="/repo/worktree">
    <SessionTranscript messages={[{ id: "a", role: "assistant", content: "[Source](src/a.ts:5)", timestamp: 1 }]}
      streamingText="[Notes](notes.md)" />
  </ChatLinkScope>);
  for (const label of ["Source", "Notes"]) {
    const link = screen.getByRole("link", { name: label });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("href")).toContain("/file-view?project=workspace");
  }
});

it("shows message timestamps in the Activity transcript", () => {
  const timestamp = new Date("2026-07-29T15:42:00.000Z").getTime();
  const messages: DisplayMessage[] = [{
    id: "assistant-1",
    role: "assistant",
    content: "The focused checks passed.",
    timestamp,
  }];

  const { container } = render(
    <SessionTranscript messages={messages} streamingText="" />,
  );

  expect(container.querySelector(".act-tx-msg time")).toHaveAttribute(
    "datetime",
    "2026-07-29T15:42:00.000Z",
  );
});
