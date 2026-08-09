/**
 * Leader preset model — persistent configuration snapshots.
 *
 * A {@link LeaderPreset} captures only the setup fields of a Leader node
 * (model, harness, permissions, thinking, skills, worktree isolation) and
 * deliberately excludes all session/runtime state (session key, messages,
 * cost, task plan, worktree path, …).
 *
 * Presets are stored in {@link ProjectSettings.leaderPresets} and are
 * applied by {@link applyPresetToLeaderData}.
 */

import type { ThinkingConfig } from "./types.ts";
import { DEFAULT_THINKING_CONFIG } from "./types.ts";
import type { PermissionMode } from "./components/SessionToolbar.tsx";
import type { LeaderData } from "./nodes/LeaderNode.tsx";

// ── Preset shape ───────────────────────────────────────────────────────────────

/**
 * A saved snapshot of a Leader's *configuration*.  Runtime state
 * (session key, messages, cost, task plan, worktree path, …) is never
 * stored here.
 *
 * Stored as an array in {@link import("./api.ts").ProjectSettings.leaderPresets}.
 */
export interface LeaderPreset {
  /** Stable identifier (UUID or similar). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Optional free-text description shown in preset pickers. */
  description?: string;
  /**
   * Optional text prepended to every system prompt when this preset is
   * active.  Useful for standing instructions that apply across sessions
   * (e.g. "You are a TypeScript expert.  Always use strict mode.").
   */
  systemPromptPrefix?: string;

  // ── Config fields mirrored from LeaderData ──────────────────────────────
  model: string;
  /** Active harness (e.g. "claude", "echo", "codex"). Omitted when absent on the source. */
  harness?: string;
  permissionMode: PermissionMode;
  thinkingConfig: ThinkingConfig;
  worktreeIsolation: boolean;
  skillIds: string[];
  skillValues: Record<string, Record<string, string>>;
  skillPanelOpen: boolean;

  // ── Bookkeeping ─────────────────────────────────────────────────────────
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
}

// ── Capture ────────────────────────────────────────────────────────────────────

export interface CapturePresetMeta {
  id: string;
  name: string;
  description?: string;
  systemPromptPrefix?: string;
}

/**
 * Build a {@link LeaderPreset} from a live {@link LeaderData}.
 *
 * Follows the same semantics as `cloneLeaderSetupData`: only configuration
 * fields are captured; session/runtime state is stripped.  All mutable
 * fields are deep-copied so the preset is independent of the source node.
 *
 * @param source  The live LeaderData to snapshot.
 * @param meta    Stable id, display name, and optional preset-level extras.
 * @param now     ISO-8601 timestamp used for `createdAt`/`updatedAt`
 *                (defaults to `new Date().toISOString()`).
 */
export function captureLeaderPreset(
  source: LeaderData,
  meta: CapturePresetMeta,
  now: string = new Date().toISOString(),
): LeaderPreset {
  const preset: LeaderPreset = {
    id: meta.id,
    name: meta.name,
    model: source.model,
    permissionMode: source.permissionMode,
    thinkingConfig: { ...(source.thinkingConfig ?? DEFAULT_THINKING_CONFIG) },
    worktreeIsolation: source.worktreeIsolation,
    skillIds: [...(source.skillIds ?? [])],
    skillValues: structuredClone(source.skillValues ?? {}),
    skillPanelOpen: source.skillPanelOpen,
    createdAt: now,
    updatedAt: now,
  };

  if (meta.description !== undefined) {
    preset.description = meta.description;
  }
  if (meta.systemPromptPrefix !== undefined) {
    preset.systemPromptPrefix = meta.systemPromptPrefix;
  }
  if (source.harness !== undefined) {
    preset.harness = source.harness;
  }

  return preset;
}

// ── Apply ──────────────────────────────────────────────────────────────────────

/**
 * Overlay a {@link LeaderPreset}'s configuration fields onto a base
 * {@link LeaderData} (typically a freshly-created default node).
 *
 * Runtime state already present on `base` is preserved — only the fields
 * tracked by the preset are overwritten.  All mutable preset fields are
 * deep-copied so the returned data is independent of the preset.
 */
export function applyPresetToLeaderData(
  preset: LeaderPreset,
  base: LeaderData,
): LeaderData {
  return {
    ...base,
    model: preset.model,
    permissionMode: preset.permissionMode,
    thinkingConfig: { ...preset.thinkingConfig },
    worktreeIsolation: preset.worktreeIsolation,
    skillIds: [...preset.skillIds],
    skillValues: structuredClone(preset.skillValues),
    skillPanelOpen: preset.skillPanelOpen,
    systemPromptPrefix: preset.systemPromptPrefix ?? null,
    ...(preset.harness !== undefined ? { harness: preset.harness } : {}),
  };
}
