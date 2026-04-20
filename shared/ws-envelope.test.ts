/**
 * ws-envelope: schema + helpers.
 *
 * The contract test that verifies every server broadcast shape parses
 * against this envelope lives in `tests/contracts/ws-envelope.test.ts`.
 */

import { describe, it, expect } from "vitest";
import {
  wsEnvelopeSchema,
  topicSchema,
  sessionTopic,
  projectTopic,
  sessionKeyFromTopic,
  topicMatches,
  GLOBAL_TOPIC,
} from "./ws-envelope.ts";

describe("ws-envelope: topic schema", () => {
  it("accepts session topics", () => {
    expect(topicSchema.parse("session:leader-abc")).toBe("session:leader-abc");
    expect(topicSchema.parse("session:m-1")).toBe("session:m-1");
  });

  it("accepts project topics", () => {
    expect(topicSchema.parse("project:p123")).toBe("project:p123");
  });

  it("accepts the global sentinel", () => {
    expect(topicSchema.parse("global")).toBe("global");
  });

  it("rejects an empty session topic", () => {
    expect(topicSchema.safeParse("session:").success).toBe(false);
  });

  it("rejects an unknown topic prefix", () => {
    expect(topicSchema.safeParse("unknown:foo").success).toBe(false);
    expect(topicSchema.safeParse("leader-abc").success).toBe(false);
  });
});

describe("ws-envelope: envelope schema", () => {
  it("parses an envelope and preserves passthrough payload fields", () => {
    const env = {
      topic: "session:abc",
      type: "task_plan_update",
      leaderSessionKey: "abc",
      tasks: [{ taskId: "t1", status: "planned" }],
    };
    const parsed = wsEnvelopeSchema.parse(env);
    expect(parsed.topic).toBe("session:abc");
    expect(parsed.type).toBe("task_plan_update");
    expect((parsed as Record<string, unknown>)["tasks"]).toEqual(env.tasks);
  });

  it("rejects an envelope without a topic", () => {
    const res = wsEnvelopeSchema.safeParse({ type: "session_status" });
    expect(res.success).toBe(false);
  });

  it("rejects an envelope without a type", () => {
    const res = wsEnvelopeSchema.safeParse({ topic: "global" });
    expect(res.success).toBe(false);
  });

  it("rejects an envelope with a malformed topic", () => {
    const res = wsEnvelopeSchema.safeParse({
      topic: "bogus",
      type: "x",
    });
    expect(res.success).toBe(false);
  });
});

describe("ws-envelope: helpers", () => {
  it("sessionTopic builds a `session:<key>` topic", () => {
    expect(sessionTopic("leader-abc")).toBe("session:leader-abc");
  });

  it("sessionTopic rejects an empty key", () => {
    expect(() => sessionTopic("")).toThrow();
  });

  it("projectTopic builds a `project:<id>` topic", () => {
    expect(projectTopic("p42")).toBe("project:p42");
  });

  it("projectTopic rejects an empty id", () => {
    expect(() => projectTopic("")).toThrow();
  });

  it("sessionKeyFromTopic extracts the key from a session topic", () => {
    expect(sessionKeyFromTopic("session:leader-abc")).toBe("leader-abc");
  });

  it("sessionKeyFromTopic returns null for non-session topics", () => {
    expect(sessionKeyFromTopic("project:p1")).toBeNull();
    expect(sessionKeyFromTopic("global")).toBeNull();
  });

  it("topicMatches requires exact equality by default", () => {
    expect(topicMatches("session:a", "session:a")).toBe(true);
    expect(topicMatches("session:a", "session:b")).toBe(false);
    expect(topicMatches("global", "global")).toBe(true);
    expect(topicMatches("global", "session:a")).toBe(false);
  });

  it("topicMatches with `*` filter accepts every envelope", () => {
    expect(topicMatches("*", "session:a")).toBe(true);
    expect(topicMatches("*", "project:p1")).toBe(true);
    expect(topicMatches("*", "global")).toBe(true);
  });

  it("GLOBAL_TOPIC is the literal 'global'", () => {
    expect(GLOBAL_TOPIC).toBe("global");
  });
});
