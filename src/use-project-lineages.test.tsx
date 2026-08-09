import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorktreeLineageSnapshot } from "../shared/worktree-integration.ts";
import { useProjectLineages } from "./use-project-lineages.ts";

function snapshot(id: string, overrides: Partial<WorktreeLineageSnapshot> = {}): WorktreeLineageSnapshot {
  return {
    id, projectId: "project-1", repositoryPath: "/repo", targetRef: "main",
    baseSha: "base", integrationRef: `refs/minions/integration/${id}`,
    integrationWorktreePath: "/repo/.worktrees/integration", integrationHeadSha: "head",
    revision: 1, integrationState: "active", status: "open",
    memberships: [], resolutionRuns: [], contributions: [],
    queue: [], gates: [], reviews: [], createdAt: 1, updatedAt: 1, ...overrides,
  };
}

describe("useProjectLineages", () => {
  it("requests the lineage list on mount", () => {
    const send = vi.fn();
    const subscribe = (_listener: (message: unknown) => void) => () => {};
    renderHook(() => useProjectLineages({ send, subscribe }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ type: "list_worktree_lineages" });
  });

  it("stores lineages from a worktree_lineages_list message", () => {
    const listeners = new Set<(message: unknown) => void>();
    const subscribe = (listener: (message: unknown) => void) => {
      listeners.add(listener); return () => listeners.delete(listener);
    };
    const { result } = renderHook(() => useProjectLineages({ send: vi.fn(), subscribe }));
    expect(result.current.allLineages).toHaveLength(0);
    act(() => {
      listeners.forEach((listener) => listener({
        type: "worktree_lineages_list", requestId: null,
        lineages: [snapshot("a"), snapshot("b")],
      }));
    });
    expect(result.current.allLineages.map((l) => l.id)).toEqual(["a", "b"]);
    expect(result.current.error).toBeNull();
  });

  it("does not fetch while disabled", () => {
    const send = vi.fn();
    const subscribe = (_listener: (message: unknown) => void) => () => {};
    renderHook(() => useProjectLineages({ send, subscribe, enabled: false }));
    expect(send).not.toHaveBeenCalled();
  });

  it("surfaces an error field from the response", () => {
    const listeners = new Set<(message: unknown) => void>();
    const subscribe = (listener: (message: unknown) => void) => {
      listeners.add(listener); return () => listeners.delete(listener);
    };
    const { result } = renderHook(() => useProjectLineages({ send: vi.fn(), subscribe }));
    act(() => {
      listeners.forEach((listener) => listener({
        type: "worktree_lineages_list", requestId: null, lineages: [], error: "Integration service unavailable",
      }));
    });
    expect(result.current.error).toBe("Integration service unavailable");
  });
});
