/**
 * ws-envelope: schema + helpers.
 *
 * The contract test that verifies every server broadcast shape parses
 * against this envelope lives in `tests/contracts/ws-envelope.test.ts`.
 */

import { describe, it, expect } from "vitest";
import {
  sessionTopic,
  projectTopic,
  lineageTopic,
  sessionKeyFromTopic,
  topicMatches,
} from "./ws-envelope.ts";

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

  it("lineageTopic builds a durable integration subscription topic", () => {
    expect(lineageTopic("lineage-42")).toBe("lineage:lineage-42");
    expect(() => lineageTopic("")).toThrow();
    expect(topicMatches("lineage:lineage-42", "lineage:lineage-42")).toBe(true);
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

  // Note: a `expect(GLOBAL_TOPIC).toBe("global")` tautology was removed per §5.7.
});
