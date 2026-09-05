/** Read-only lifecycle playbooks. Retrieval grants no authority or tools. */
import { body as graph_authoring } from "./leader-procedures/graph_authoring.ts";
import { body as review_start } from "./leader-procedures/review_start.ts";
import { body as adjudication } from "./leader-procedures/adjudication.ts";
import { body as cancellation_recovery } from "./leader-procedures/cancellation_recovery.ts";
import { body as reconciliation } from "./leader-procedures/reconciliation.ts";
import { body as dialectic } from "./leader-procedures/dialectic.ts";

export const LEADER_PROCEDURE_TOOL_NAMES = ["load_procedure"] as const;
export const LEADER_PROCEDURE_IDS = ["graph_authoring", "review_start", "adjudication", "cancellation_recovery", "reconciliation", "dialectic"] as const;
export type LeaderProcedureId = typeof LEADER_PROCEDURE_IDS[number];
const procedures = {
  graph_authoring: { id: "graph_authoring", description: "Author or revise graph topology and artifact contracts", body: graph_authoring },
  review_start: { id: "review_start", description: "Review a proposal or resolve its start gate", body: review_start },
  adjudication: { id: "adjudication", description: "Inspect completion evidence or an unsuccessful verification verdict", body: adjudication },
  cancellation_recovery: { id: "cancellation_recovery", description: "Cancel obsolete work or resume from retained recovery evidence", body: cancellation_recovery },
  reconciliation: { id: "reconciliation", description: "Close a Work Packet after execution and a stable diff", body: reconciliation },
  dialectic: { id: "dialectic", description: "Choose or moderate a bounded reasoning dialectic", body: dialectic },
} as const;
export function listLeaderProcedures() {
  return LEADER_PROCEDURE_IDS.map(id => ({ id, description: procedures[id].description }));
}
export function getLeaderProcedure(id: string) {
  return Object.hasOwn(procedures, id) ? procedures[id as LeaderProcedureId] : null;
}
/** Attach this pointer to phase transitions; the caller owns graph response wiring. */
export function leaderProcedurePointer(id: LeaderProcedureId): string {
  return `Before this phase, call load_procedure with ${JSON.stringify({ id })}. Retrieval supplies instructions, not permission or runtime authority.`;
}
export function buildLeaderProcedureDiscovery(toolName: string): string {
  return `## Lifecycle procedures

Call \`${toolName}\` with {} to discover procedures, or {"id":"graph_authoring"} to retrieve one. Load the relevant procedure before entering its phase; load another only when the phase changes. Tool schemas and server policy remain authoritative.

${listLeaderProcedures().map(p => `- \`${p.id}\`: ${p.description}.`).join("\n")}`;
}
