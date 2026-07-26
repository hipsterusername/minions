/**
 * Selector for the Activity empty-state "Recent agent work" preview.
 *
 * Merges live (non-minion) sessions with canvas leader nodes that carry prior
 * work, so the preview still has content when the live session list is empty
 * (e.g. after a restart, or when every session is filtered out of the current
 * view). Pure logic — colocated tests in `activity-recent-work.test.ts`.
 */

import type { CanvasNode } from "./types.ts";
import type { LeaderData } from "./nodes/leader/types.ts";
import type { MobileSessionInfo } from "./mobile/mobile-selectors.ts";
import { sessionDisplayTitle } from "./mobile/mobile-selectors.ts";

export interface RecentAgentWork {
  /** Stable identity — sessionKey when known, otherwise the node id. */
  key: string;
  title: string;
  /** Latest visible slice of the agent's work (report, activity, or message). */
  snippet: string;
  /** Session status when a live session backs this entry. */
  status: string | null;
  lastActivityAt: number | null;
  /** Canvas node to reveal on click, when the agent is on the canvas. */
  nodeId: string | null;
  /** Session to attach on click, when no canvas node exists yet. */
  sessionKey: string | null;
}

const SNIPPET_LIMIT = 160;

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= SNIPPET_LIMIT) return flat;
  return `${flat.slice(0, SNIPPET_LIMIT - 1).trimEnd()}…`;
}

/** Last user-meaningful message in a leader transcript (assistant preferred). */
function latestNodeSnippet(data: LeaderData): { snippet: string; at: number | null } {
  const messages = data.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "assistant" && message.role !== "user") continue;
    if (!message.content.trim()) continue;
    return { snippet: truncate(message.content), at: message.timestamp ?? null };
  }
  const last = messages.at(-1);
  return { snippet: "", at: last?.timestamp ?? null };
}

/**
 * Up to `limit` most recent agents with work worth previewing, newest first.
 * Sessions win over their canvas node for metadata; the node contributes the
 * click-through target (`nodeId`) and a transcript-derived fallback snippet.
 */
export function selectRecentAgentWork(
  sessions: MobileSessionInfo[],
  nodes: CanvasNode[],
  limit = 3,
): RecentAgentWork[] {
  const leaderNodes = nodes.filter((node) => node.type === "leader");
  const nodeBySessionKey = new Map<string, CanvasNode>();
  for (const node of leaderNodes) {
    const sessionKey = (node.data as LeaderData).sessionKey;
    if (sessionKey) nodeBySessionKey.set(sessionKey, node);
  }

  const entries: RecentAgentWork[] = [];
  const seenSessionKeys = new Set<string>();

  for (const session of sessions) {
    if (session.role === "minion") continue;
    // Dismissed sessions stay out of every surface the user has closed them
    // from — resurfacing them in the preview would undo the dismissal.
    seenSessionKeys.add(session.sessionKey);
    if (session.reviewLifecycle?.dismissedAt != null) continue;
    const node = nodeBySessionKey.get(session.sessionKey);
    const nodeSnippet = node ? latestNodeSnippet(node.data as LeaderData) : null;
    const snippet =
      session.reviewLifecycle?.finalReport?.trim() ||
      session.lastActivity?.trim() ||
      nodeSnippet?.snippet ||
      session.cwd ||
      "";
    entries.push({
      key: session.sessionKey,
      title: sessionDisplayTitle(session),
      snippet: truncate(snippet),
      status: session.status,
      lastActivityAt: session.lastActivityAt ?? nodeSnippet?.at ?? null,
      nodeId: node?.id ?? null,
      sessionKey: session.sessionKey,
    });
  }

  for (const node of leaderNodes) {
    const data = node.data as LeaderData;
    if (data.sessionKey && seenSessionKeys.has(data.sessionKey)) continue;
    const { snippet, at } = latestNodeSnippet(data);
    // A node with neither a transcript nor a name is a blank draft — skip it.
    if (!snippet && !data.taskName) continue;
    entries.push({
      key: data.sessionKey ?? node.id,
      title: data.taskName?.trim() || "Untitled agent",
      snippet,
      status: null,
      lastActivityAt: at,
      nodeId: node.id,
      sessionKey: data.sessionKey ?? null,
    });
  }

  return entries
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
    .slice(0, limit);
}
