/**
 * Render DSL — a compact component vocabulary for agent-driven dashboards.
 *
 * The Leader agent emits render commands using MCP tools. Each command
 * carries a payload described by these types. The RenderNode on the
 * canvas interprets the payload and renders live React components.
 *
 * Design principles:
 *   1. Token-efficient — agents describe UI in minimal JSON
 *   2. Patch-friendly — every component has an `id` for targeted updates
 *   3. Constrained — fixed set of primitives, no arbitrary HTML/React
 */

// ── Component primitives ───────────────────────────────

export interface MetricComponent {
  id: string;
  type: "metric";
  label: string;
  value: string;
  color?: "green" | "red" | "yellow" | "blue" | "gray" | "purple" | "orange";
  trend?: "up" | "down" | "flat";
  /** Optional small text beneath the value */
  detail?: string;
}

export interface ProgressComponent {
  id: string;
  type: "progress";
  label: string;
  /** 0–100 */
  value: number;
  color?: "green" | "red" | "yellow" | "blue" | "gray" | "purple" | "orange";
}

export interface TableComponent {
  id: string;
  type: "table";
  title?: string;
  headers: string[];
  rows: string[][];
}

export interface ListComponent {
  id: string;
  type: "list";
  title?: string;
  items: string[];
  ordered?: boolean;
}

export interface TextComponent {
  id: string;
  type: "text";
  /** Rendered as markdown */
  content: string;
}

export interface StatusComponent {
  id: string;
  type: "status";
  label: string;
  state: "success" | "error" | "warning" | "running" | "pending";
}

export interface CodeComponent {
  id: string;
  type: "code";
  language?: string;
  content: string;
  title?: string;
}

export type RenderComponent =
  | MetricComponent
  | ProgressComponent
  | TableComponent
  | ListComponent
  | TextComponent
  | StatusComponent
  | CodeComponent;

// ── Layout ─────────────────────────────────────────────

export interface RenderLayout {
  /** Number of grid columns (default 2) */
  columns?: number;
  /** Gap between components in px (default 12) */
  gap?: number;
  /** Optional dashboard title shown at the top */
  title?: string;
}

// ── Full render state ──────────────────────────────────

export interface RenderState {
  layout: RenderLayout;
  components: RenderComponent[];
}

// ── Messages (agent → render node) ─────────────────────

/** Replace the entire render tree */
export interface RenderSetMessage {
  action: "set";
  layout?: RenderLayout;
  components: RenderComponent[];
}

/** Update specific components by id (partial merge) */
export interface RenderPatchMessage {
  action: "patch";
  /** Each entry must include `id` plus the fields to update */
  updates: Array<{ id: string } & Partial<Omit<RenderComponent, "id">>>;
}

/** Remove components by id */
export interface RenderRemoveMessage {
  action: "remove";
  ids: string[];
}

/** Append new components to the existing tree */
export interface RenderAppendMessage {
  action: "append";
  components: RenderComponent[];
}

export type RenderMessage =
  | RenderSetMessage
  | RenderPatchMessage
  | RenderRemoveMessage
  | RenderAppendMessage;

// ── Helpers ────────────────────────────────────────────

/** Apply a RenderMessage to existing state, returning new state. */
export function applyRenderMessage(
  state: RenderState,
  msg: RenderMessage,
): RenderState {
  switch (msg.action) {
    case "set":
      return {
        layout: msg.layout ?? state.layout,
        components: msg.components,
      };

    case "patch": {
      const updates = new Map(msg.updates.map((u) => [u.id, u]));
      return {
        ...state,
        components: state.components.map((c) => {
          const patch = updates.get(c.id);
          if (!patch) return c;
          // Merge patch into component, preserving type
          return { ...c, ...patch, id: c.id, type: c.type } as RenderComponent;
        }),
      };
    }

    case "remove": {
      const removeSet = new Set(msg.ids);
      return {
        ...state,
        components: state.components.filter((c) => !removeSet.has(c.id)),
      };
    }

    case "append": {
      // Deduplicate: if an appended component's id already exists, replace it
      const existingIds = new Set(msg.components.map((c) => c.id));
      const filtered = state.components.filter((c) => !existingIds.has(c.id));
      return {
        ...state,
        components: [...filtered, ...msg.components],
      };
    }
  }
}

/** Create an empty render state */
export function emptyRenderState(): RenderState {
  return { layout: { columns: 2, gap: 12 }, components: [] };
}
