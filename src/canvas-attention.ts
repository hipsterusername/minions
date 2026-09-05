import type { CanvasNode } from "./types.ts";
import type { LeaderData } from "./nodes/leader/types.ts";
import { leaderHasReviewableChanges } from "./ChangesView.tsx";
import { attentionReason, compareActivityPriority, isVisibleInActivity, needsAttention, sessionDisplayTitle, type MobileSessionInfo } from "./mobile/mobile-selectors.ts";

export interface CanvasAttentionItem {
  session: MobileSessionInfo;
  nodeId: string | null;
  title: string;
  reason: string;
  zoneName?: string | undefined;
}

/** Reuse Activity's lifecycle, review and visibility rules, including detached work. */
export function canvasAttentionItems(sessions: MobileSessionInfo[], nodes: CanvasNode[]): CanvasAttentionItem[] {
  const leaders = nodes.filter(node => node.type === "leader");
  return sessions.filter(session => session.role !== "minion").map(session => {
    const node = leaders.find(node => session.workItemId && (node.data as LeaderData).workItemId === session.workItemId)
      ?? leaders.find(node => (node.data as LeaderData).sessionKey === session.sessionKey);
    const enriched = { ...session, reviewableChanges: session.reviewableChanges === true || (!!node && leaderHasReviewableChanges(node.data as LeaderData)) };
    return { session: enriched, nodeId: node?.id ?? null, title: sessionDisplayTitle(enriched), reason: attentionReason(enriched) };
  }).filter(item => isVisibleInActivity(item.session, "open") && needsAttention(item.session))
    .sort((a, b) => compareActivityPriority(a.session, b.session));
}
