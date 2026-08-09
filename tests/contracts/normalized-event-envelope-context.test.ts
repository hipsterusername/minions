import { describe, expect, it } from "vitest";
import { normalizedEventEnvelopeSchema } from "../../shared/ws-envelope.ts";

describe("normalized event envelope identity context", () => {
  const legacyEnvelope = {
    topic: "session:run-1",
    type: "sdk_event",
    sessionKey: "run-1",
    event: { kind: "text", role: "assistant", text: "hello" },
    timestamp: 1,
  };

  it("accepts canonical work-item and run identity", () => {
    expect(normalizedEventEnvelopeSchema.parse({
      ...legacyEnvelope,
      runKey: "run-1",
      workItemId: "work-1",
    })).toMatchObject({ runKey: "run-1", workItemId: "work-1" });
  });

  it("accepts an explicit null work item during the additive migration", () => {
    expect(normalizedEventEnvelopeSchema.safeParse({
      ...legacyEnvelope,
      runKey: "run-1",
      workItemId: null,
    }).success).toBe(true);
  });

  it("keeps persisted legacy envelopes readable", () => {
    expect(normalizedEventEnvelopeSchema.safeParse(legacyEnvelope).success).toBe(true);
  });

  it("rejects malformed canonical identifiers", () => {
    expect(normalizedEventEnvelopeSchema.safeParse({
      ...legacyEnvelope,
      runKey: "",
      workItemId: "",
    }).success).toBe(false);
  });
});
