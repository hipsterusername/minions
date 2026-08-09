import type { ServerMessage, SessionInfo } from "../use-socket.ts";
import { sessionDisplayTitle } from "./mobile-selectors.ts";

export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileChange {
  file: string;
  insertions: number;
  deletions: number;
  status: FileChangeStatus;
}

export interface DetailedDiff {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: FileChange[];
  commits: string[];
  branch: string;
}

export interface PendingApproval {
  sessionKey: string;
  summary: string;
  graceUntil?: number;
  diff?: DetailedDiff;
  sessionTitle?: string;
}

export type PendingApprovalsMap = Record<string, PendingApproval>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFileChange(value: unknown): value is FileChange {
  if (!isRecord(value)) return false;
  return (
    typeof value["file"] === "string" &&
    typeof value["insertions"] === "number" &&
    typeof value["deletions"] === "number" &&
    (value["status"] === "added" ||
      value["status"] === "modified" ||
      value["status"] === "deleted" ||
      value["status"] === "renamed")
  );
}

export function isDetailedDiff(value: unknown): value is DetailedDiff {
  if (!isRecord(value)) return false;
  return (
    typeof value["filesChanged"] === "number" &&
    typeof value["insertions"] === "number" &&
    typeof value["deletions"] === "number" &&
    Array.isArray(value["files"]) &&
    value["files"].every(isFileChange) &&
    Array.isArray(value["commits"]) &&
    value["commits"].every((commit) => typeof commit === "string") &&
    typeof value["branch"] === "string"
  );
}

function withoutApproval(
  current: PendingApprovalsMap,
  sessionKey: string,
): PendingApprovalsMap {
  if (!(sessionKey in current)) return current;
  const next = { ...current };
  delete next[sessionKey];
  return next;
}

function pendingApprovalFrom(input: {
  sessionKey: string;
  summary: string;
  graceUntil?: number | undefined;
  diff?: unknown;
  sessionTitle?: string | undefined;
}): PendingApproval {
  const approval: PendingApproval = {
    sessionKey: input.sessionKey,
    summary: input.summary,
  };
  if (input.graceUntil !== undefined) approval.graceUntil = input.graceUntil;
  if (isDetailedDiff(input.diff)) approval.diff = input.diff;
  if (input.sessionTitle !== undefined) approval.sessionTitle = input.sessionTitle;
  return approval;
}

export function reduceApprovalMessage(
  current: PendingApprovalsMap,
  msg: ServerMessage,
): PendingApprovalsMap {
  switch (msg.type) {
    case "approval_requested":
      return {
        ...current,
        [msg.sessionKey]: pendingApprovalFrom({
          sessionKey: msg.sessionKey,
          summary: msg.summary,
          graceUntil: msg.graceUntil,
          diff: msg.diff,
          sessionTitle: current[msg.sessionKey]?.sessionTitle,
        }),
      };
    case "sync_response":
      if (msg.approval?.requested === true) {
        return {
          ...current,
          [msg.sessionKey]: pendingApprovalFrom({
            sessionKey: msg.sessionKey,
            summary: msg.approval.summary ?? "Changes ready for review",
            graceUntil: msg.approval.graceUntil,
            diff: msg.approval.diff,
            sessionTitle: current[msg.sessionKey]?.sessionTitle,
          }),
        };
      }
      return withoutApproval(current, msg.sessionKey);
    case "approval_resolved":
    case "worktree_merged":
    case "session_completed":
    case "worktree_removed":
      return withoutApproval(current, msg.sessionKey);
    default:
      return current;
  }
}

export function pendingApprovalsList(
  map: PendingApprovalsMap,
  sessions: ReadonlyArray<SessionInfo>,
): PendingApproval[] {
  const titleBySession = new Map(
    sessions.map((session) => [session.sessionKey, sessionDisplayTitle(session)]),
  );

  return Object.values(map)
    .map((approval) => ({
      ...approval,
      sessionTitle: titleBySession.get(approval.sessionKey) ?? approval.sessionTitle ?? approval.sessionKey,
    }))
    .sort((a, b) => (a.sessionTitle ?? a.sessionKey).localeCompare(b.sessionTitle ?? b.sessionKey));
}

export function approvalsBadgeCount(map: PendingApprovalsMap): number {
  return Object.keys(map).length;
}

export function formatDiffStat(diff: DetailedDiff | null | undefined): string {
  if (!diff) return "Diff pending";
  return `${diff.filesChanged} ${diff.filesChanged === 1 ? "file" : "files"} +${diff.insertions} -${diff.deletions}`;
}

export function fileStatusSymbol(status: FileChangeStatus): string {
  switch (status) {
    case "added":
      return "+";
    case "modified":
      return "~";
    case "deleted":
      return "-";
    case "renamed":
      return ">";
    default:
      return "?";
  }
}
