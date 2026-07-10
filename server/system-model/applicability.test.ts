// Tests for the deterministic packet-applicability logic (redesign §5/§6).
// Uses the shared valid fixture, whose `gate.review` and critical
// `constraint.bus_only` both scope to the nested `server` TS glob.

import { describe, expect, it } from "vitest";
import {
  computePacketApplicability,
  gatedSurfaceGlobs,
  renderPacketNote,
} from "./applicability.ts";
import { loadSystemModel } from "./load.ts";

const model = loadSystemModel("tests/fixtures/system-model/valid").model!;

describe("computePacketApplicability", () => {
  it("flags packetRequired when a file hits a gate glob and a critical-constraint glob", () => {
    const result = computePacketApplicability(model, ["server/commands/approve-changes.ts"]);
    expect(result.packetRequired).toBe(true);
    expect(result.gateHits).toEqual(["gate.review"]);
    expect(result.constraintHits).toEqual(["constraint.bus_only"]);
  });

  it("returns no hit when files miss every gated surface", () => {
    const result = computePacketApplicability(model, ["src/App.tsx", "docs/readme.md"]);
    expect(result).toEqual({ packetRequired: false, gateHits: [], constraintHits: [] });
  });

  it("never requires a packet for an empty file list (silence is the default)", () => {
    expect(computePacketApplicability(model, [])).toEqual({
      packetRequired: false,
      gateHits: [],
      constraintHits: [],
    });
  });

  it("ignores non-critical constraints (only critical severity counts)", () => {
    // The fixture's only critical constraint is bus_only; a src-only file
    // matches neither the gate nor a critical constraint.
    const result = computePacketApplicability(model, ["src/Canvas.tsx"]);
    expect(result.constraintHits).toEqual([]);
    expect(result.packetRequired).toBe(false);
  });
});

describe("gatedSurfaceGlobs", () => {
  it("returns the unique, sorted union of gate and critical-constraint globs", () => {
    expect(gatedSurfaceGlobs(model)).toEqual(["server/**/*.ts"]);
  });
});

describe("renderPacketNote", () => {
  it("is empty on a miss", () => {
    expect(renderPacketNote({ packetRequired: false, gateHits: [], constraintHits: [] })).toBe("");
  });

  it("renders gate + constraint hits on a hit", () => {
    const note = renderPacketNote({
      packetRequired: true,
      gateHits: ["gate.review"],
      constraintHits: ["constraint.bus_only"],
    });
    expect(note).toContain("packetRequired: true");
    expect(note).toContain("gate.review");
    expect(note).toContain("constraint.bus_only");
    expect(note).not.toContain("workPacketId");
  });

  it("adds the work-packet reminder only when asked", () => {
    const note = renderPacketNote(
      { packetRequired: true, gateHits: ["gate.review"], constraintHits: [] },
      { remindWorkPacket: true },
    );
    expect(note).toContain("workPacketId");
    expect(note).toContain("create_work_packet");
  });
});
