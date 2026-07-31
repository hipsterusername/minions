import { render } from "@testing-library/react";
import { expect, it } from "vitest";

import type { DisplayMessage } from "../sdk-messages.ts";
import { SessionTranscript } from "./SessionTranscript.tsx";

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
