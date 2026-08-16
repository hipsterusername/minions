import type { ContextItem } from "../../types.ts";
import { buildContextBlock } from "../../connected-context.ts";
import { seedContextDelivery } from "../../context-delivery.ts";
import { mergeContextPreamble, resolveContextMode } from "../../leader-context-mode.ts";
import { buildSessionContext } from "./session-context.ts";
import { freezeLeaderSystemPrompt } from "./frozen-prompt.ts";
import type { LeaderData } from "./types.ts";

const LEADER_AUTOSTART_DEDUPE_WINDOW_MS = 10_000;
const leaderAutoStartClaims = new Map<string, number>();

export function claimLeaderAutoStart(
  nodeId: string,
  prompt: string,
  now: number = Date.now(),
): boolean {
  for (const [key, claimedAt] of leaderAutoStartClaims) {
    if (now - claimedAt > LEADER_AUTOSTART_DEDUPE_WINDOW_MS) leaderAutoStartClaims.delete(key);
  }
  const key = `${nodeId}\0${prompt}`;
  const claimedAt = leaderAutoStartClaims.get(key);
  if (claimedAt !== undefined && now - claimedAt <= LEADER_AUTOSTART_DEDUPE_WINDOW_MS) return false;
  leaderAutoStartClaims.set(key, now);
  return true;
}

export function resetLeaderAutoStartClaimsForTests(): void {
  leaderAutoStartClaims.clear();
}

export function releaseLeaderAutoStart(nodeId: string, prompt: string): void {
  leaderAutoStartClaims.delete(`${nodeId}\0${prompt}`);
}

export function buildInitialLeaderRun(input: {
  userPrompt: string; data: LeaderData; contextItems: ContextItem[];
  incomingModes: string[]; at?: number;
}) {
  const { userPrompt, data, contextItems } = input;
  const sessionContext = buildSessionContext(data.messages, data.taskPlan ?? [], data.taskName);
  const block = buildContextBlock(contextItems);
  let prompt = block ? `${block}\n\n${userPrompt}` : userPrompt;
  if (sessionContext) prompt = `${sessionContext}\n\n${prompt}`;
  const frozen = freezeLeaderSystemPrompt({ skillIds: data.skillIds ?? [],
    skillValues: data.skillValues ?? {}, orchestrationMode: data.orchestrationMode ?? "auto",
    systemPromptPrefix: mergeContextPreamble(
      input.incomingModes.map(resolveContextMode), data.systemPromptPrefix) });
  return { prompt, frozen, previousMessages: data.messages,
    attachments: contextItems.flatMap((item) => item.attachments ?? []),
    contextDelivery: seedContextDelivery(contextItems, input.at ?? Date.now()) };
}
