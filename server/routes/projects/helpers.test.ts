/**
 * Unit tests for the edge row mapper — specifically the per-edge
 * `context_mode` <-> `contextMode` round-trip added for leader→leader
 * context forwarding.
 */
import { describe, it, expect } from "vitest";
import { rowToEdge, type EdgeRow } from "./helpers.ts";

function edgeRow(contextMode: string | null): EdgeRow {
  return {
    id: "e1",
    project_id: "p1",
    source_node_id: "leader-a",
    source_port_id: "context-out",
    target_node_id: "leader-b",
    target_port_id: "context-in",
    protocol: "context",
    z_index: 0,
    context_mode: contextMode,
    created_at: "now",
    updated_at: "now",
  };
}

describe("rowToEdge context_mode mapping", () => {
  it("maps a non-null context_mode to contextMode", () => {
    expect(rowToEdge(edgeRow("full"))).toMatchObject({ contextMode: "full" });
    expect(rowToEdge(edgeRow("lean"))).toMatchObject({ contextMode: "lean" });
  });

  it("omits contextMode entirely when the column is null", () => {
    const edge = rowToEdge(edgeRow(null));
    expect("contextMode" in edge).toBe(false);
  });
});
