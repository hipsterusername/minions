import { describe, expect, it } from "vitest";
import { canvasRunStreamPatch } from "./canvas-run-stream.ts";

describe("canvas run transitions", () => {
  it("keeps unresolved local submissions while clearing the previous conversation", () => {
    const states = ["sending", "unconfirmed", "failed", "accepted", "queued"] as const;
    const messages = states.map((id) => ({ id, role: "user" as const, content: id, timestamp: 1 }));
    const messageDelivery = Object.fromEntries(states.map((state) => [state, { state, text: state }]));
    const patch = canvasRunStreamPatch("old-run", "new-run", { messages, messageDelivery });
    expect(patch.messages?.map((message) => message.id)).toEqual(["sending", "unconfirmed", "failed"]);
    expect(patch).toMatchObject({ sessionKey: "new-run", streamingText: "", totalCost: 0, turns: 0 });
    expect(messages).toHaveLength(5);
  });
});
