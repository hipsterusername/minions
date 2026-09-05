import { FormSubmissionProvider } from "./render/FormSubmissionProvider.tsx";
import { useState, useEffect, useRef, useCallback, useMemo, useSyncExternalStore } from "react";
import { Maximize2, Square, Zap } from "lucide-react";
import type { NodeRenderProps, ThinkingConfig } from "../types.ts";
import { DEFAULT_THINKING_CONFIG } from "../types.ts";
import { registerNodeType } from "../node-registry.ts";
import { registerContract, LEADER_CONTRACT } from "../graph.ts";
import { subscribeSocketTopic, type ServerMessage } from "../use-socket.ts";
import { useStatusBanners, StatusBannerStack } from "../components/StatusBanner.tsx";
import { preserveOptimisticUserMessages, type SessionStreamState } from "../session-stream.ts";
import { useSessionStream } from "../use-session-stream.ts";
import { SessionToolbar } from "../components/SessionToolbar.tsx";
import type { PermissionMode } from "../components/SessionToolbar.tsx";
import { getSkill } from "../skills/registry.ts";
import { SkillsPill } from "./leader/skills/SkillsPill.tsx";
import { ResizeHandle } from "../components/ResizeHandle.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { debugFlagStore } from "../debug.ts";
import { useLeaderFullscreenRequest } from "../use-leader-fullscreen-request.ts";
import { ConfirmModal } from "../components/ConfirmModal.tsx";
import { canvasScale } from "../canvas-scale.ts";
import { groupMessages } from "./leader-message-helpers.ts";
import { sessionTopic } from "../../shared/ws-envelope.ts";
import { applyRenderMessage, emptyRenderState, renderMessageSchema } from "../../shared/render-dsl.ts";
import { flattenRenderStateToText } from "../render-flatten.ts";
import { LeaderBody } from "./leader/LeaderBody.tsx";
import {
  LEADER_DEFAULT_DATA,
  LEADER_PROMPT_OVERLAY_ZOOM_THRESHOLD,
  type LeaderData, type MessageContextSelection,
  type TaskPlanItem,
} from "./leader/types.ts";
import { buildSessionContext, extractLeaderCore, msgId } from "./leader/session-context.ts";
import { EditableTitle } from "./leader/EditableTitle.tsx";
import {
  sendCanvasContextSnapshotIfChanged,
  type CanvasContextSignature,
} from "../connected-context.ts";
import { type FrozenLeaderPrompt } from "./leader/frozen-prompt.ts";
import { consumeLeaderInputFocus } from "../leader-focus-request.ts";
import {
  formatCanvasWorkItemStatus, selectCanvasChangeMode, selectCanvasPrompt } from "./leader/work-item.ts";
import { useCanvasDelivery } from "./leader/use-canvas-delivery.ts";
import { useLaunchFeedback } from "./leader/use-launch-feedback.ts";
import { WorkItemCommandError } from "./leader/work-item.ts";
import { CanvasDeliveryContext } from "./leader/CanvasDeliveryReceipt.tsx";
import { useCanvasWorkItem } from "./leader/use-canvas-work-item.ts";
import { buildInitialLeaderRun, claimLeaderAutoStart, releaseLeaderAutoStart } from "./leader/initial-run.ts";
import { armLeaderCompletionSound, playLeaderCompletionSound } from "../leader-completion-sound.ts";
export { claimLeaderAutoStart, resetLeaderAutoStartClaimsForTests } from "./leader/initial-run.ts";

registerContract(LEADER_CONTRACT);

const LEADER_DASHBOARD_EXPANDED_WIDTH = 1040;
const LEADER_DASHBOARD_EXPANDED_HEIGHT = 620;

// Re-exports preserved so external consumers (Canvas, leader-preset,
// tests, etc.) keep importing types from "./LeaderNode.tsx" without churn while
// the file is drained into focused modules under ./leader/.
export {
  LEADER_DEFAULT_DATA,
  LEADER_PROMPT_OVERLAY_ZOOM_THRESHOLD,
  buildSessionContext,
};
export type { LeaderData, TaskPlanItem };

import { LeaderMessageFeed } from "./leader/messages/LeaderMessageFeed.tsx";

import { TaskPlanPanel } from "./leader/TaskPlanPanel.tsx";

import { SkillFlyout } from "./leader/skills/SkillFlyout.tsx";

import { ConfigFooter } from "./leader/ConfigFooter.tsx";

import { HeaderMenu } from "./leader/HeaderMenu.tsx";
import { LeaderStatusIcon } from "./leader/LeaderStatusIcon.tsx";
import { PromptAttachmentsContext, usePromptAttachments } from "./leader/prompt/use-prompt-attachments.ts";
import { LeaderPromptBar, LeaderSlashCommandsProvider } from "./leader/prompt/LeaderPromptBar.tsx";
import { LeaderPromptOverlay } from "./leader/prompt/LeaderPromptOverlay.tsx";
import { DashboardSurface } from "./render/DashboardSurface.tsx";
import { LeaderFullscreen } from "./leader/fullscreen/LeaderFullscreen.tsx";
import { buildSlashCommands } from "./leader/prompt/slash-commands.ts";
import "./leader/leader-node.css";
import { MinionsSurface } from "./leader/MinionsSurface.tsx";
import { ActivityLaunchForm } from "./leader/ActivityLaunchForm.tsx";
import { DEFAULT_SANDBOX_POLICY } from "./leader/SandboxPolicyControls.tsx";
import { invokeContextAction } from "../../shared/context-actions.ts";
import { LeaderTaskGraphBridge } from "../task-graph/LeaderTaskGraphBridge.tsx";
import { useLeaderTaskGraphController } from "../task-graph/use-leader-task-graph-controller.ts";

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/* ── Main component ───────────────────────────────────────────────────── */

export function LeaderNodeRenderer({
  node,
  onUpdateData,
  socketSend,
  socketSubscribe,
  getContextForNode,
  getIncomingContextModes,
  projectPath,
  projectId,
  projectSettings,
  onResize,
  onResizeStart,
  onResizeEnd,
  onAddContentNode,
  onDuplicateLeaderSetup,
  onOpenSystemModel,
  onSaveLeaderPreset,
  launchMode = false,
}: NodeRenderProps & { launchMode?: boolean }) {
  const data = node.data as LeaderData;
  const slashCommands = useMemo(
    () => buildSlashCommands(projectSettings),
    [projectSettings],
  );
  const dataRef = useRef(data);
  dataRef.current = data;
  const taskGraphController = useLeaderTaskGraphController({
    workItemId: data.workItemId ?? data.workItemSnapshot?.id ?? null,
    socketSend,
    socketSubscribe,
  });

  const [input, setInput] = useState("");
  const promptAttachments = usePromptAttachments();
  const submittedAttachmentIds = useRef<string[]>([]);
  const [tasksExpanded, setTasksExpanded] = useState(false);
  const [skillFlyoutOpen, setSkillFlyoutOpen] = useState(false);
  const [promptOverlayOpen, setPromptOverlayOpen] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [scrollLocked, setScrollLocked] = useState(false);
  const [selectedMinionTaskId, setSelectedMinionTaskId] = useState<string | null>(null);
  // Fullscreen cockpit (ephemeral, per-instance, per-session — mirrors the
  // MarkdownNode focus-mode rationale). Toggle via the header button or
  // Cmd/Ctrl+Shift+F when the leader card owns focus; Esc to exit.
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Wire-validation error for the most recent embedded-dashboard render_update.
  const [renderPayloadError, setRenderPayloadError] = useState<string | null>(null);
  const [launchNotice, setLaunchNotice] = useState<string | null>(null);

  const handleContextActionSelect = useCallback((command: (typeof slashCommands)[number]) => {
    const current = dataRef.current;
    const invocation = invokeContextAction(
      { prompt: command.insertText, skillIds: command.skillIds ?? [] },
      current.skillIds ?? [],
      (command.skillIds ?? []).filter((id) => getSkill(id) !== undefined),
    );
    if (!sameStringArray(invocation.skillIds, current.skillIds ?? [])) {
      const next = { ...current, skillIds: invocation.skillIds };
      dataRef.current = next;
      onUpdateData(next);
    }
    setLaunchNotice(invocation.missingSkillIds.length > 0
      ? `Action inserted. Unavailable Skills were not armed: ${invocation.missingSkillIds.join(", ")}.`
      : null);
  }, [onUpdateData, slashCommands]);

  useEffect(() => {
    armLeaderCompletionSound();
  }, []);

  // Post embedded-dashboard `form` answers back to this leader session.
  const handleSubmitForm = useCallback(
    (formComponentId: string, formAnswers: Record<string, unknown>) => {
      const sessionKey = dataRef.current.sessionKey;
      if (!sessionKey || !socketSend) return;
      socketSend({ type: "submit_form", sessionKey, formComponentId, formAnswers });
    },
    [socketSend],
  );
  const [messageContextSelection, setMessageContextSelection] =
    useState<MessageContextSelection | null>(null);
  const skillAnchorRef = useRef<HTMLDivElement>(null);
  // Anchor for the SkillFlyout when triggered from the fullscreen cockpit
  // (different DOM tree from skillAnchorRef which lives in the in-canvas card).
  const fullscreenSkillAnchorRef = useRef<HTMLElement | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const scrollZoneRef = useRef<HTMLDivElement>(null);
  const nodeRootRef = useRef<HTMLDivElement | null>(null);
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const syncedRef = useRef(false);
  const frozenPromptRef = useRef<FrozenLeaderPrompt | null>(null);
  const canvasContextSignatureRef = useRef<CanvasContextSignature>(null);
  const { banners, processNormalizedEvent, dismissBanner } = useStatusBanners();
  const debugEnabled = useSyncExternalStore(
    debugFlagStore.subscribe,
    debugFlagStore.getSnapshot,
    debugFlagStore.getSnapshot,
  );
  const groupedMessages = useMemo(() => groupMessages(data.messages), [data.messages]);
  const minionTasks = useMemo(
    () => (data.taskPlan ?? []).filter((task) => task.executor === "minion"),
    [data.taskPlan],
  );
  const activateMessageSelection = useCallback((messageId: string) => {
    setMessageContextSelection({
      messageId,
      selectedChunkIds: [],
      anchorChunkId: null,
    });
  }, []);
  const exitMessageSelection = useCallback(() => {
    setMessageContextSelection(null);
  }, []);

  // Auto-expand the plan panel when the first task is registered
  const prevPlanCountRef = useRef(0);
  useEffect(() => {
    const count = data.taskPlan?.length ?? 0;
    if (count > 0 && prevPlanCountRef.current === 0) {
      setTasksExpanded(true);
    }
    prevPlanCountRef.current = count;
  }, [data.taskPlan]);

  useEffect(() => {
    const prompt = dataRef.current.draftPrompt;
    if (!prompt) return;
    setInput(prompt);
    onUpdateData({ ...dataRef.current, draftPrompt: null });
  }, [data.draftPrompt, onUpdateData]);

  // Close flyout panels on any wheel event (covers zoom + scroll).
  // Reading the external scale store avoids busting React.memo.
  useEffect(() => {
    if (!skillFlyoutOpen) return;
    const close = () => setSkillFlyoutOpen(false);
    window.addEventListener("wheel", close, { passive: true, once: true });
    return () => window.removeEventListener("wheel", close);
  }, [skillFlyoutOpen]);

  // Fullscreen keyboard handler — Cmd/Ctrl+Shift+F toggles when this node
  // owns focus (or when no card is in fullscreen), Esc exits. Window-level
  // listener (not editor-level) so it fires from any child surface (title
  // input, composer, etc.). Matches the MarkdownNode focus-mode pattern.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && (e.key === "f" || e.key === "F")) {
        const root = nodeRootRef.current;
        const focused = document.activeElement;
        const owns = root && (root === focused || root.contains(focused));
        if (owns || isFullscreen) {
          e.preventDefault();
          setIsFullscreen((v) => !v);
        }
        return;
      }
      if (e.key === "Escape" && isFullscreen && !e.defaultPrevented
        && !document.querySelector('[role="dialog"]:not([data-testid="leader-fullscreen-overlay"]), [role="menu"]')) {
        e.preventDefault();
        setIsFullscreen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isFullscreen]);

  // The Activity view (or any sibling surface) can ask this node to open its
  // cockpit by id; the hook bridges that request channel to local state.
  useLeaderFullscreenRequest(node.id, () => setIsFullscreen(true));

  // Click-outside: deactivate scroll lock when clicking outside the scroll zone
  useEffect(() => {
    if (!scrollLocked) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (scrollZoneRef.current && !scrollZoneRef.current.contains(e.target as Node)) {
        setScrollLocked(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [scrollLocked]);

  // Native wheel listener on the scroll zone: stops the event from bubbling to
  // the canvas container's native handler (which calls preventDefault and zooms).
  // React's synthetic onWheel fires at the React root — above the canvas container —
  // so it's too late to stopPropagation there. This native listener fires first.
  useEffect(() => {
    const zone = scrollZoneRef.current;
    if (!zone) return;
    const stop = (e: WheelEvent) => { e.stopPropagation(); };
    zone.addEventListener("wheel", stop, { passive: false });
    return () => zone.removeEventListener("wheel", stop);
  }, []);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [data.messages.length]);

  useEffect(() => {
    if (!socketSend || !data.sessionKey || syncedRef.current) return;
    syncedRef.current = true;
    socketSend({ type: "sync_session", sessionKey: data.sessionKey });
  }, [socketSend, data.sessionKey]);

  const publishCanvasContext = useCallback((
    sessionKey: string,
    items = getContextForNode?.() ?? [],
    previousSignature = canvasContextSignatureRef.current,
  ) => {
    canvasContextSignatureRef.current = sendCanvasContextSnapshotIfChanged({
      socketSend,
      sessionKey,
      items,
      previousSignature,
    });
  }, [socketSend, getContextForNode]);

  useEffect(() => {
    if (data.sessionKey) publishCanvasContext(data.sessionKey);
  });

  // Helper: update dataRef *synchronously* so rapid-fire WS events within the
  // same frame each see the latest state, then dispatch to React.
  const emitUpdate = useCallback(
    (next: LeaderData) => {
      const current = dataRef.current;
      const protectedNext = current.workItemSnapshot
        ? { ...next, status: current.status, worktreeStatus: current.worktreeStatus }
        : next;
      dataRef.current = protectedNext;
      onUpdateData(protectedNext);
    },
    [onUpdateData],
  );
  const selectMinionTask = useCallback((taskIdOrSessionKey: string) => {
    const task = (dataRef.current.taskPlan ?? []).find(
      (candidate) =>
        candidate.executor === "minion" &&
        (candidate.taskId === taskIdOrSessionKey || candidate.minionSessionKey === taskIdOrSessionKey),
    );
    if (!task) return;
    setSelectedMinionTaskId(task.taskId);
    emitUpdate({ ...dataRef.current, activeBodyView: "minions" });
  }, [emitUpdate]);

  const { requestWorkItem, beginCanonicalRun, sendCanonicalPrompt } = useCanvasWorkItem({ nodeId: node.id,
    projectId, projectPath, socketSend, socketSubscribe, dataRef, emitUpdate,
    publishCanvasContext });

  // ── Shared session-stream concerns via the controlled hook ────────
  //
  // The hook owns the WebSocket subscription for messages, status,
  // cost, turns, error and streaming-text deltas. Node-specific
  // reactions to session_status (clearing waitUntil when the session
  // resumes) are layered into applyCoreUpdate. All other node-specific
  // events — session_task_name, wait_state, worktree_*, approval_*,
  // and the extra worktree/taskName/approval fields on sync_response
  // — live in the secondary subscription below.
  const applyCoreUpdate = useCallback(
    (next: SessionStreamState) => {
      const current = dataRef.current;

      let merged: LeaderData = {
        ...current,
        sessionKey: next.sessionKey,
        contextDelivery: next.contextDelivery ?? current.contextDelivery,
        status: next.status,
        // A sync rebuild may omit optimistic user turns. Re-graft
        // them so the user's own messages never disappear between agent turns.
        messages: preserveOptimisticUserMessages(current.messages, next.messages),
        streamingText: next.streamingText,
        streamingBlockIndex: next.streamingBlockIndex,
        totalCost: next.totalCost,
        turns: next.turns,
        error: next.error,
        fullError: next.fullError ?? next.error,
      };

      // Clear wait state when the session resumes (auto-continue fired).
      if (
        current.status !== "running" &&
        next.status === "running" &&
        current.waitUntil
      ) {
        merged = { ...merged, waitUntil: null, waitReason: null };
      }

      emitUpdate(merged);
    },
    [emitUpdate],
  );

  useSessionStream({
    ...(socketSubscribe ? { socketSubscribe } : {}),
    state: extractLeaderCore(data),
    onChange: applyCoreUpdate,
    prefix: "lm",
  });

  // ── Node-specific subscription (layered ON TOP of the hook) ───────
  //
  // Declared AFTER `useSessionStream` so it subscribes second and fires
  // second on each message — by the time this runs, `dataRef.current`
  // already reflects the hook's update from the same dispatch.
  useEffect(() => {
    if (!socketSubscribe || !data.sessionKey) return;
    return subscribeSocketTopic(socketSubscribe, sessionTopic(data.sessionKey), (msg: unknown) => {
      const serverMsg = msg as ServerMessage & Record<string, any>;
      const current = dataRef.current;

      if (serverMsg.type === "session_launch_resolved" && serverMsg.sessionKey === current.sessionKey) {
        setLaunchNotice(
          `Using ${serverMsg.effective.harness} / ${serverMsg.effective.model} with ${serverMsg.effective.permissionMode} for this session (${serverMsg.reasons.join(", ").replaceAll("_", " ")}).`,
        );
      }

      if (!current.sessionKey) return;

      if (
        serverMsg.type === "sdk_event" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        processNormalizedEvent(serverMsg.event);
        if (serverMsg.event.kind === "done") {
          playLeaderCompletionSound();
          if (current.status !== "idle") {
            emitUpdate({ ...dataRef.current, status: "idle" });
          }
        }
        return;
      }

      // sync_response found: restore worktree/taskName/approval fields
      // that the shared reducer doesn't know about.
      if (
        serverMsg.type === "sync_response" &&
        serverMsg.sessionKey === current.sessionKey &&
        serverMsg.found
      ) {
        const syncData: Partial<LeaderData> = {};

        if (serverMsg.worktree) {
          const wt = serverMsg.worktree;
          syncData.worktreePath = wt.path;
          syncData.worktreeBranch = wt.branch;
          syncData.worktreeStatus = "active";
        }
        if (serverMsg.taskName) {
          syncData.taskName = serverMsg.taskName;
        }
        if (serverMsg.lastErrorFull !== undefined) {
          syncData.fullError = serverMsg.lastErrorFull ?? null;
        }
        if (serverMsg.harness) syncData.harness = serverMsg.harness;
        if (serverMsg.sandboxPolicy) {
          syncData.sandboxPolicy = serverMsg.sandboxPolicy.requested;
          syncData.effectiveSandboxPolicy = serverMsg.sandboxPolicy;
        }
        if (Array.isArray(serverMsg.taskPlan)) {
          const existingMap = new Map(
            (current.taskPlan ?? []).map((task) => [task.taskId, task]),
          );
          syncData.taskPlan = serverMsg.taskPlan.map((task) => {
            const existing = existingMap.get(task.taskId);
            return {
              taskId: task.taskId,
              title: task.title,
              description: task.description,
              priority: task.priority,
              status: task.status as TaskPlanItem["status"],
              executor: task.executor,
              minionSessionKey: task.minionSessionKey,
              result: task.result,
              cost: existing?.cost ?? 0,
              createdAt: task.createdAt,
              completedAt: task.completedAt,
              sessionSummary: existing?.sessionSummary ?? "",
              activeStep:
                task.status === "running" || task.status === "starting"
                  ? (existing?.activeStep ?? null)
                  : null,
              progress: existing?.progress ?? [],
            };
          });
        }
        const syncApproval = serverMsg.approval as
          | {
              requested?: boolean;
              summary?: string;
              diff?: LeaderData["approvalDiff"];
            }
          | null
          | undefined;
        if (syncApproval?.requested && selectCanvasChangeMode(current) === "worktree") {
          syncData.approvalPending = true;
          syncData.approvalSummary = syncApproval.summary ?? null;
          syncData.approvalDiff = syncApproval.diff ?? null;
        } else {
          syncData.approvalPending = false;
        }

        if (Object.keys(syncData).length > 0) {
          emitUpdate({ ...current, ...syncData });
        }
        return;
      }

      // session_task_name — agent set its display name
      if (
        serverMsg.type === "session_task_name" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        emitUpdate({ ...current, taskName: serverMsg.taskName });
        return;
      }

      // wait_state — leader is waiting or wait completed/cancelled
      if (
        serverMsg.type === "wait_state" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        if (serverMsg.action === "started") {
          emitUpdate({
            ...current,
            waitUntil:
              (serverMsg.scheduledAt as number) +
              (serverMsg.durationMs as number),
            waitReason: serverMsg.reason as string,
          });
        } else {
          // completed or cancelled — clear wait state
          emitUpdate({ ...current, waitUntil: null, waitReason: null });
        }
        return;
      }

      // worktree_created
      if (
        serverMsg.type === "worktree_created" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        emitUpdate({
          ...current,
          worktreePath: serverMsg.worktreePath as string,
          worktreeBranch: serverMsg.branch as string,
          worktreeStatus: "active",
        });
        return;
      }

      // worktree_failed — isolation was requested but creation failed
      if (
        serverMsg.type === "worktree_failed" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        emitUpdate({
          ...current,
          worktreeStatus: "failed",
          error: (serverMsg.error as string) ?? "Worktree creation failed",
        });
        return;
      }

      // worktree_merged — merge succeeded and worktree was cleaned up
      if (
        serverMsg.type === "worktree_merged" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        emitUpdate({
          ...current,
          worktreePath: null,
          worktreeBranch: null,
          worktreeStatus: "merged",
          mergeConflict: null,
          mergeConfirmed: true,
          // Clear approval state inline — don't rely on approval_resolved
          // arriving separately, as React batching may cause stale spreads.
          approvalPending: false,
          approvalSummary: null,
          approvalDiff: null,
        });
        return;
      }

      // worktree_merge_failed — conflicts, worktree still active
      if (
        serverMsg.type === "worktree_merge_failed" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        const result = serverMsg.result as
          | { conflicts?: string[]; summary?: string; targetBranch?: string }
          | undefined;
        emitUpdate({
          ...current,
          worktreeStatus: "active",
          approvalPending: true,
          mergeConflict: {
            conflicts: result?.conflicts ?? [],
            summary: result?.summary ?? "Merge conflicts detected",
            targetBranch: result?.targetBranch ?? "main",
          },
          error: null,
        });
        return;
      }

      // worktree_removed (explicit discard)
      if (
        serverMsg.type === "worktree_removed" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        emitUpdate({
          ...current,
          worktreePath: null,
          worktreeBranch: null,
          worktreeStatus: "discarded",
          approvalPending: false,
          approvalSummary: null,
          approvalDiff: null,
        });
        return;
      }

      // approval_requested — leader is waiting for user to approve
      if (
        serverMsg.type === "approval_requested" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        if (selectCanvasChangeMode(current) !== "worktree") return;
        emitUpdate({
          ...current,
          approvalPending: true,
          approvalSummary: (serverMsg.summary as string) ?? null,
          approvalDiff:
            (serverMsg.diff as LeaderData["approvalDiff"]) ?? null,
        });
        return;
      }

      // approval_resolved — approval was accepted or changes requested
      if (
        serverMsg.type === "approval_resolved" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        emitUpdate({
          ...current,
          approvalPending: false,
          approvalSummary: null,
          approvalDiff: null,
          // If approved, the worktree_merged event handles worktree status.
        });
        return;
      }

      // render_update — live dashboard payload for the embedded surface.
      // Apply validated dashboard payloads and surface wire errors locally.
      if (
        serverMsg.type === "render_update" &&
        (serverMsg as { leaderSessionKey?: string }).leaderSessionKey === current.sessionKey
      ) {
        const parsed = renderMessageSchema.safeParse(serverMsg);
        if (!parsed.success) {
          const detail = parsed.error.issues.map((i) => i.message).join("; ");
          setRenderPayloadError(`Invalid render payload: ${detail}`);
          return;
        }
        setRenderPayloadError(null);
        const hadDashboardContent = (current.renderState?.components.length ?? 0) > 0;
        const newState = applyRenderMessage(
          current.renderState ?? emptyRenderState(),
          parsed.data,
        );
        const hasDashboardContent = newState.components.length > 0;
        if (!hadDashboardContent && hasDashboardContent && onResize) {
          const nextSize = {
            width: Math.max(node.size.width, LEADER_DASHBOARD_EXPANDED_WIDTH),
            height: Math.max(node.size.height, LEADER_DASHBOARD_EXPANDED_HEIGHT),
          };
          if (nextSize.width !== node.size.width || nextSize.height !== node.size.height) {
            onResize(nextSize);
          }
        }
        emitUpdate({ ...current, renderState: newState });
        return;
      }

      // Handle session_completed — session lifecycle is done (e.g. after merge)
      if (serverMsg.type === "session_completed" && serverMsg.sessionKey === current.sessionKey) {
        emitUpdate({
          ...current,
          status: "completed",
          // Ensure ALL transient state is cleared — don't rely on prior
          // events having propagated due to React batching / event ordering.
          approvalPending: false,
          approvalSummary: null,
          approvalDiff: null,
          mergeConflict: null,
          waitUntil: null,
          waitReason: null,
          error: null,
        });
        return;
      }
    });
  }, [socketSubscribe, data.sessionKey, emitUpdate, processNormalizedEvent, onResize, node.size.width, node.size.height]);

  const launchFeedback = useLaunchFeedback(data, nodeRootRef,
    (prompt) => {
      setInput((draft) => draft === prompt ? "" : draft);
      promptAttachments.remove(submittedAttachmentIds.current);
      submittedAttachmentIds.current = [];
    },
    () => { syncedRef.current = false; emitUpdate({ ...dataRef.current, sessionKey: null }); });

  const handleCreate = useCallback(() => {
    if (!socketSend) return;
    // syncedRef is claimed synchronously by the first path (autoStart / create /
    // reattach); guarding here closes the double-create race (duplicate host).
    if (syncedRef.current || !promptAttachments.canSubmit() || !launchFeedback.begin(input)) return;
    submittedAttachmentIds.current = promptAttachments.drafts.map(draft => draft.id);
    const key = `leader-${Date.now().toString(36)}`;
    const userPrompt =
      input.trim() || (promptAttachments.items.length ? "Use the attached context." : "Analyze the project and suggest how to proceed.");

    const contextItems = getContextForNode?.() ?? [];
    const { prompt: fullPrompt, frozen: frozenPrompt, previousMessages: prevMessages,
      attachments, contextDelivery } = buildInitialLeaderRun({ userPrompt,
      data: dataRef.current, contextItems, promptContextItems: promptAttachments.items, incomingModes: getIncomingContextModes?.() ?? [] });
    frozenPromptRef.current = frozenPrompt;

    if (projectId && projectPath) {
      syncedRef.current = true;
      emitUpdate({ ...dataRef.current, status: "creating", contextDelivery,
        messages: [...prevMessages, { id: msgId(), role: "user" as const,
          content: userPrompt, timestamp: Date.now() }] });
      void beginCanonicalRun({ userPrompt, prompt: fullPrompt,
        systemPrompt: frozenPrompt.systemPrompt, attachments, contextItems })
        .catch((error: unknown) => {
          const uncertain = !(error instanceof WorkItemCommandError);
          launchFeedback.failed(uncertain);
          syncedRef.current = uncertain;
          emitUpdate({ ...dataRef.current, status: "error",
            error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    socketSend({
      type: "create_session",
      sessionKey: key,
      prompt: fullPrompt,
      systemPrompt: frozenPrompt.systemPrompt,
      role: "leader",
      skillIds: data.skillIds ?? [], skillValues: data.skillValues ?? {},
      model: data.model,
      thinkingConfig: data.thinkingConfig ?? DEFAULT_THINKING_CONFIG,
      permissionMode: data.permissionMode,
      worktreeIsolation: data.worktreeIsolation,
      sandboxPolicy: data.sandboxPolicy ?? DEFAULT_SANDBOX_POLICY,
      ...(data.harness ? { harness: data.harness } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(projectId ? { workspaceId: projectId } : projectPath ? { cwd: projectPath } : {}),
    });
    publishCanvasContext(key, contextItems, null);
    syncedRef.current = true;
    onUpdateData({
      ...dataRef.current,
      sessionKey: key,
      status: "creating",
      contextDelivery,
      messages: [
        ...prevMessages,
        {
          id: msgId(),
          role: "user" as const,
          content: userPrompt,
          timestamp: Date.now(),
        },
      ],
    });
  }, [socketSend, input, getContextForNode, getIncomingContextModes, publishCanvasContext,
    data.skillIds, data.skillValues, data.model, data.thinkingConfig, data.sandboxPolicy, projectId,
    projectPath, emitUpdate, beginCanonicalRun, launchFeedback, promptAttachments]);
  const autoStartFired = useRef(false);
  useEffect(() => {
    if (autoStartFired.current) return;
    const prompt = dataRef.current.autoStartPrompt;
    if (!prompt || dataRef.current.sessionKey || !socketSend || syncedRef.current) return;
    if (!claimLeaderAutoStart(node.id, prompt)) return;
    autoStartFired.current = true;
    launchFeedback.begin(prompt);
    submittedAttachmentIds.current = promptAttachments.drafts.map(draft => draft.id);

    const key = `leader-${Date.now().toString(36)}`;

    const contextItems = getContextForNode?.() ?? [];
    const { prompt: fullPrompt, frozen: frozenPrompt, previousMessages: prevMessages,
      attachments, contextDelivery } = buildInitialLeaderRun({ userPrompt: prompt,
      data: dataRef.current, contextItems, promptContextItems: promptAttachments.items, incomingModes: getIncomingContextModes?.() ?? [] });
    frozenPromptRef.current = frozenPrompt;

    if (projectId && projectPath) {
      syncedRef.current = true;
      emitUpdate({ ...dataRef.current, status: "creating", autoStartPrompt: null,
        contextDelivery, messages: [...prevMessages, { id: msgId(), role: "user" as const,
          content: prompt, timestamp: Date.now() }] });
      void beginCanonicalRun({ userPrompt: prompt, prompt: fullPrompt,
        systemPrompt: frozenPrompt.systemPrompt, attachments, contextItems })
        .catch((error: unknown) => {
          const uncertain = !(error instanceof WorkItemCommandError);
          launchFeedback.failed(uncertain);
          syncedRef.current = uncertain;
          if (!uncertain) releaseLeaderAutoStart(node.id, prompt);
          setInput((draft) => draft || prompt);
          emitUpdate({ ...dataRef.current, status: "error", autoStartPrompt: null,
            error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    socketSend({
      type: "create_session",
      sessionKey: key,
      prompt: fullPrompt,
      systemPrompt: frozenPrompt.systemPrompt,
      role: "leader",
      skillIds: dataRef.current.skillIds ?? [], skillValues: dataRef.current.skillValues ?? {},
      model: dataRef.current.model,
      thinkingConfig: dataRef.current.thinkingConfig ?? DEFAULT_THINKING_CONFIG,
      permissionMode: dataRef.current.permissionMode,
      worktreeIsolation: dataRef.current.worktreeIsolation,
      sandboxPolicy: dataRef.current.sandboxPolicy ?? DEFAULT_SANDBOX_POLICY,
      ...(dataRef.current.harness ? { harness: dataRef.current.harness } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(projectId ? { workspaceId: projectId } : projectPath ? { cwd: projectPath } : {}),
    });
    publishCanvasContext(key, contextItems, null);
    syncedRef.current = true;
    onUpdateData({
      ...dataRef.current,
      sessionKey: key,
      status: "creating",
      autoStartPrompt: null,
      contextDelivery,
      messages: [
        ...prevMessages,
        {
          id: msgId(),
          role: "user" as const,
          content: prompt,
          timestamp: Date.now(),
        },
      ],
    });
  }, [socketSend, onUpdateData, getContextForNode, getIncomingContextModes,
    publishCanvasContext, projectPath, projectId, emitUpdate, beginCanonicalRun]);

  // Focus the prompt input when this node was just created by the user, so they
  // can start typing immediately. The one-shot request (set by Canvas at
  // creation) is claimed exactly once and never fires for rehydrated nodes.
  const focusClaimedRef = useRef(false);
  useEffect(() => {
    if (focusClaimedRef.current) return;
    if (!consumeLeaderInputFocus(node.id)) return;
    focusClaimedRef.current = true;
    // The canvas owns viewport movement. Native focus scrolling can otherwise
    // fight its creation transform and shift the page/canvas a second time.
    promptTextareaRef.current?.focus({ preventScroll: true });
  }, [node.id]);

  const delivery = useCanvasDelivery({ dataRef, emitUpdate, socketSend, socketSubscribe,
    getContextForNode, frozenPromptRef, requestWorkItem, sendCanonicalPrompt });
  const handleSend = useCallback(() => {
    if (!promptAttachments.canSubmit()) return;
    const text = input.trim() ? input : promptAttachments.items.length ? "Use the attached context." : "";
    if (delivery.send(text, promptAttachments.items)) {
      setInput("");
      promptAttachments.remove(promptAttachments.drafts.map(draft => draft.id));
    }
  }, [delivery, input, promptAttachments]);

  const handleStop = useCallback(() => {
    const current = dataRef.current;
    if (!socketSend || !current.sessionKey) return;
    socketSend({ type: "stop_session", sessionKey: current.sessionKey });
  }, [socketSend]);

  const handleModelChange = useCallback(
    (model: string) => {
      const current = dataRef.current;
      onUpdateData({ ...current, model });
      if (socketSend && current.sessionKey) {
        socketSend({ type: "set_model", sessionKey: current.sessionKey, model });
      }
    },
    [socketSend, onUpdateData],
  );

  const handleHarnessChange = useCallback(
    (harness: string, defaultModel?: string) => {
      const current = dataRef.current;
      // Mid-session harness changes would invalidate the active run.
      if (current.sessionKey) return;
      // Apply harness + model atomically. Two separate onUpdateData calls
      // would both read the stale `dataRef.current` and the second would
      // clobber the harness update.
      onUpdateData({
        ...current,
        harness,
        ...(defaultModel ? { model: defaultModel } : {}),
      });
    },
    [onUpdateData],
  );

  const handlePermissionModeChange = useCallback(
    (mode: PermissionMode) => {
      const current = dataRef.current;
      onUpdateData({ ...current, permissionMode: mode });
      if (socketSend && current.sessionKey) {
        socketSend({ type: "set_permission_mode", sessionKey: current.sessionKey, permissionMode: mode });
      }
    },
    [socketSend, onUpdateData],
  );

  // Thinking config takes effect on the *next* turn — every turn re-creates
  // the SDK query() with fresh options. We don't push a runtime command;
  // the server reads the latest config from each send_message payload.
  const handleThinkingConfigChange = useCallback(
    (cfg: ThinkingConfig) => {
      const current = dataRef.current;
      onUpdateData({ ...current, thinkingConfig: cfg });
    },
    [onUpdateData],
  );

  const resetSession = useCallback(() => {
    if (socketSend && data.sessionKey) {
      socketSend({ type: "stop_session", sessionKey: data.sessionKey });
    }
    syncedRef.current = false;
    canvasContextSignatureRef.current = null;
    emitUpdate({
      ...LEADER_DEFAULT_DATA,
      skillIds: data.skillIds,
      skillValues: data.skillValues,
      model: data.model,
      permissionMode: data.permissionMode,
      sandboxPolicy: data.sandboxPolicy ?? DEFAULT_SANDBOX_POLICY,
      thinkingConfig: data.thinkingConfig ?? DEFAULT_THINKING_CONFIG,
      worktreeIsolation: data.worktreeIsolation,
    });
  }, [socketSend, data, emitUpdate]);

  const handleReset = useCallback(() => {
    setResetConfirmOpen(true);
  }, []);

  // New Session handler — preserves conversation context for continuity.
  // If the user has typed a prompt in the input, it becomes the autoStartPrompt
  // for the new session so they don't have to click "Start" again.
  const handleNewSession = useCallback(() => {
    const current = dataRef.current;
    const pendingPrompt = input.trim() || (promptAttachments.items.length ? "Use the attached context." : null);
    // Stop the old session on the server if it's still tracked
    if (socketSend && current.sessionKey) {
      socketSend({ type: "stop_session", sessionKey: current.sessionKey });
    }
    // Reset to default state but keep messages + taskPlan so buildSessionContext
    // can inject them as <previous-session-context> on the next handleCreate().
    // Also preserve user preferences (model, skills, permissions, isolation).
    syncedRef.current = false;
    canvasContextSignatureRef.current = null;
    emitUpdate({
      ...LEADER_DEFAULT_DATA,
      messages: current.messages,
      taskPlan: current.taskPlan,
      taskName: current.taskName,
      skillIds: current.skillIds,
      skillValues: current.skillValues,
      model: current.model,
      permissionMode: current.permissionMode,
      sandboxPolicy: current.sandboxPolicy ?? DEFAULT_SANDBOX_POLICY,
      orchestrationMode: current.orchestrationMode ?? "auto",
      worktreeIsolation: false, // worktree isolation off by default
      ...(pendingPrompt ? { autoStartPrompt: pendingPrompt } : {}),
    });
    setInput("");
  }, [socketSend, emitUpdate, input, promptAttachments]);

  const { displayStatus, placeholder: promptPlaceholder,
    submitLabel: baseSubmitLabel, submitDisabled: baseSubmitDisabled,
    submitActive: promptSubmitActive } = selectCanvasPrompt(data, Boolean(input.trim()) || promptAttachments.items.length > 0);

  const promptSubmitLabel = launchFeedback.pending ? "Starting leader…" : baseSubmitLabel;
  const promptSubmitDisabled = launchFeedback.pending || baseSubmitDisabled || promptAttachments.blocked;

  const handlePromptSubmit = useCallback(() => {
    if (promptSubmitDisabled) return;

    if (dataRef.current.workItemSnapshot
      && dataRef.current.workItemSnapshot.lifecycle.outcome !== "none") {
      handleSend();
    } else if (dataRef.current.status === "completed") {
      handleNewSession();
    } else if (dataRef.current.sessionKey) {
      handleSend();
    } else {
      handleCreate();
    }

    setPromptOverlayOpen(false);
  }, [handleCreate, handleNewSession, handleSend, promptSubmitDisabled]);

  const handlePromptTextareaFocus = useCallback(() => {
    if (canvasScale.current <= LEADER_PROMPT_OVERLAY_ZOOM_THRESHOLD) {
      setPromptOverlayOpen(true);
    }
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape" && promptOverlayOpen) {
        e.preventDefault();
        setPromptOverlayOpen(false);
        return;
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handlePromptSubmit();
      }
    },
    [handlePromptSubmit, promptOverlayOpen],
  );

  const handleExportLog = useCallback(() => {
    const lines = data.messages.map((m) => {
      const ts = new Date(m.timestamp).toISOString();
      return `[${ts}] [${m.role}] ${m.content}${m.suffix ? ` (${m.suffix})` : ""}`;
    });
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `leader-log-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [data.messages]);

  const statusColor: Record<string, string> = {
    disconnected: "var(--text-muted)",
    creating: "var(--status-creating)",
    running: "var(--success-color)",
    idle: "var(--status-idle)",
    inactive: "var(--status-idle)",
    stopped: "var(--status-error)",
    error: "var(--danger-color)",
    completed: "var(--success-color)",
  };

  const configFooter = <ConfigFooter data={data} onUpdateData={emitUpdate} socketSend={socketSend}
    socketSubscribe={socketSubscribe} getContextForNode={getContextForNode} onNewSession={handleNewSession} />;
  const headerMenu = <HeaderMenu data={data} onReset={handleReset} onExportLog={handleExportLog}
    onDuplicateSetup={onDuplicateLeaderSetup ? () => { setIsFullscreen(false); onDuplicateLeaderSetup(); } : undefined}
    onOpenSystemModel={onOpenSystemModel ? () => { setIsFullscreen(false); onOpenSystemModel(); } : undefined} onSavePreset={onSaveLeaderPreset} />;
  const minionsSurface = <MinionsSurface tasks={minionTasks} selectedTaskId={selectedMinionTaskId}
    onSelectTask={setSelectedMinionTaskId} socketSend={socketSend} socketSubscribe={socketSubscribe} />;

  const taggedSkillCount = (data.skillIds ?? []).length;

  if (launchMode) {
    return (
      <FormSubmissionProvider key={data.sessionKey} sessionKey={data.sessionKey ?? ""} socketSend={socketSend} socketSubscribe={socketSubscribe}><CanvasDeliveryContext.Provider value={delivery}><PromptAttachmentsContext.Provider value={promptAttachments}><LeaderSlashCommandsProvider commands={slashCommands} onSelect={handleContextActionSelect}>
        <ActivityLaunchForm nodeId={node.id} data={data} input={input} slashCommands={slashCommands}
          promptPlaceholder={promptPlaceholder} submitDisabled={promptSubmitDisabled} submitActive={promptSubmitActive} pending={launchFeedback.pending} unavailableReason={!socketSend ? "Connection unavailable" : undefined} textareaRef={promptTextareaRef} {...(projectPath ? { projectPath } : {})}
          onInputChange={setInput} onKeyDown={handleKeyDown} onSubmit={handlePromptSubmit} onUpdate={(patch) => onUpdateData({ ...dataRef.current, ...patch })} />
        {launchFeedback.notice || launchNotice ? <div className="leader-launch-notice" role="status">{launchFeedback.notice ?? launchNotice}</div> : null}
      </LeaderSlashCommandsProvider></PromptAttachmentsContext.Provider></CanvasDeliveryContext.Provider></FormSubmissionProvider>
    );
  }

  return (
    <FormSubmissionProvider key={data.sessionKey} sessionKey={data.sessionKey ?? ""} socketSend={socketSend} socketSubscribe={socketSubscribe}><CanvasDeliveryContext.Provider value={delivery}><PromptAttachmentsContext.Provider value={promptAttachments}><LeaderSlashCommandsProvider commands={slashCommands} onSelect={handleContextActionSelect}>
    <div
      ref={nodeRootRef}
      tabIndex={-1}
      data-fullscreen={isFullscreen} inert={isFullscreen}
      data-status={displayStatus}
      className="leader-node"
    >
      {launchFeedback.notice && <div className={launchFeedback.pending ? "leader-launch-notice" : "leader-node__announcement"} role="status">{launchFeedback.notice}</div>}
      {onResize && (
        <ResizeHandle
          currentSize={node.size}
          minWidth={360}
          minHeight={320}
          onResize={onResize}
          {...(onResizeStart ? { onResizeStart } : {})}
          {...(onResizeEnd ? { onResizeEnd } : {})}
          color="var(--accent)"
        />
      )}

      <header className="leader-node__header">
        <div className="leader-node__identity">
          <div className="leader-node__avatar" aria-hidden="true">
            <LeaderStatusIcon
              active={displayStatus === "running" || displayStatus === "creating"}
              size={20}
              decorative
            />
            <span className="leader-node__presence" />
          </div>
          <div className="leader-node__heading">
            <div className="leader-node__title">
              <EditableTitle
                value={data.taskName ?? "Leader"}
                onChange={(name) => onUpdateData({ ...data, taskName: name || null })}
              />
              {taggedSkillCount > 0 && (
                <button
                  type="button"
                  className="leader-node__skill-count"
                  onClick={() => setSkillFlyoutOpen(true)}
                  onMouseDown={(e) => e.stopPropagation()}
                  title={`${taggedSkillCount} skill${taggedSkillCount === 1 ? "" : "s"} configured`}
                  aria-label={`Edit ${taggedSkillCount} configured skill${taggedSkillCount === 1 ? "" : "s"}`}
                >
                  <Zap size={10} strokeWidth={2.2} aria-hidden="true" />
                  {taggedSkillCount}
                </button>
              )}
            </div>
            <div className="leader-node__meta">
              <span
                className="leader-node__status"
                style={{ color: statusColor[displayStatus] ?? "var(--text-muted)" }}
              >
                {formatCanvasWorkItemStatus(data.workItemSnapshot, data.liveEditAwareness) ?? displayStatus}
              </span>
              {data.turns > 0 && (
                <span className="leader-node__turns">
                  {data.turns} turn{data.turns !== 1 ? "s" : ""}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="leader-node__actions">
          {data.totalCost > 0 && (
            <span className="leader-node__cost" title="Session cost">
              ${data.totalCost.toFixed(4)}
            </span>
          )}
          {displayStatus === "running" && (
            <button
              type="button"
              className="leader-node__stop"
              onClick={handleStop}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <Square size={8} fill="currentColor" aria-hidden="true" />
              Stop
            </button>
          )}
          <button
            type="button"
            className="leader-node__icon-button"
            onClick={() => setIsFullscreen(true)}
            onMouseDown={(e) => e.stopPropagation()}
            aria-label="Enter fullscreen"
            aria-pressed={isFullscreen}
            title="Fullscreen cockpit (⌘⇧F)"
            data-testid="leader-fullscreen-enter"
          >
            <Maximize2 size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
          {headerMenu}
        </div>
      </header>

      <SessionToolbar
        className="leader-session-toolbar"
        sessionKey={data.sessionKey}
        status={displayStatus}
        model={data.model ?? "opus"}
        permissionMode={data.permissionMode ?? "auto"}
        onModelChange={handleModelChange}
        onPermissionModeChange={handlePermissionModeChange}
        thinkingConfig={data.thinkingConfig ?? DEFAULT_THINKING_CONFIG}
        onThinkingConfigChange={handleThinkingConfigChange}
        harness={data.harness ?? "claude"}
        onHarnessChange={handleHarnessChange}
        accent="var(--accent)"
        skillsContent={
          <div
            ref={skillAnchorRef}
            className="leader-node__skills"
          >
            <SkillsPill
              skillIds={data.skillIds ?? []}
              open={skillFlyoutOpen}
              onOpen={() => setSkillFlyoutOpen(true)}
            />
          </div>
        }
      />

      <StatusBannerStack banners={banners} onDismiss={dismissBanner} />
      {launchNotice ? <div role="status" style={{ padding: "6px 10px", fontSize: 11, background: "var(--warning-bg)", color: "var(--text-primary)" }}>{launchNotice}</div> : null}
      <LeaderTaskGraphBridge
        controller={taskGraphController}
        goal={data.taskName ?? null}
        plan={data.taskPlan ?? []}
        onAdjust={() => promptTextareaRef.current?.focus()}
      />

      <SkillFlyout
        skillIds={data.skillIds ?? []}
        skillValues={data.skillValues ?? {}}
        open={skillFlyoutOpen}
        readOnly={false}
        anchorRef={isFullscreen ? fullscreenSkillAnchorRef : skillAnchorRef}
        onUpdate={(patch) => {
          onUpdateData({ ...dataRef.current, ...patch });
        }}
        onClose={() => setSkillFlyoutOpen(false)}
      />

      <div
        ref={scrollZoneRef}
        data-scroll-capture
        onPointerDown={() => setScrollLocked(true)}
        className={`leader-scroll-zone${scrollLocked ? " leader-scroll-zone--locked" : ""}`}
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          position: "relative",
        }}
      >
      {!isFullscreen && <LeaderBody
        renderState={data.renderState ?? emptyRenderState()}
        payloadError={renderPayloadError}
        onSubmitForm={handleSubmitForm}
        onAddContentNode={onAddContentNode}
        activeBodyView={data.activeBodyView}
        onActiveBodyViewChange={(v) => emitUpdate({ ...dataRef.current, activeBodyView: v })}
        splitRatio={data.dashboardSplitRatio}
        onSplitRatioChange={(r) => emitUpdate({ ...dataRef.current, dashboardSplitRatio: r })}
        dashboardHeaderActive={(data.taskPlan?.length ?? 0) > 0}
        minionsActive={minionTasks.length > 0}
        minionCount={minionTasks.length}
        minions={minionsSurface}
        dashboardHeader={
          <TaskPlanPanel
            taskPlan={data.taskPlan ?? []}
            expanded={tasksExpanded}
            onToggle={() => setTasksExpanded((p) => !p)}
            onRevealMinion={selectMinionTask}
          />
        }
        chat={
          <>
      <LeaderMessageFeed
        outputRef={outputRef}
        data={data}
        groupedMessages={groupedMessages}
        messageContextSelection={messageContextSelection}
        onActivateMessageSelection={activateMessageSelection}
        onMessageSelectionChange={setMessageContextSelection}
        onExitMessageSelection={exitMessageSelection}
        onAddContentNode={onAddContentNode}
        debugEnabled={debugEnabled}
        isWorking={displayStatus === "running"}
      />

      {configFooter}

      <LeaderPromptBar
        input={input}
        slashCommands={slashCommands}
        onInputChange={setInput}
        onKeyDown={handleKeyDown}
        onSubmit={handlePromptSubmit}
        placeholder={promptPlaceholder}
        submitLabel={promptSubmitLabel}
        disabled={promptSubmitDisabled}
        active={promptSubmitActive}
        onTextareaFocus={handlePromptTextareaFocus}
        textareaRef={promptTextareaRef}
      />
          </>
        }
      />}
      </div>

      <LeaderPromptOverlay
        open={promptOverlayOpen}
        input={input}
        title={data.taskName ?? "Leader"}
        messages={data.messages}
        streamingText={data.streamingText}
        status={displayStatus}
        onClose={() => setPromptOverlayOpen(false)}
        onInputChange={setInput}
        onKeyDown={handleKeyDown}
        onSubmit={handlePromptSubmit}
        placeholder={promptPlaceholder}
        submitLabel={promptSubmitLabel}
        disabled={promptSubmitDisabled}
        active={promptSubmitActive}
      />

      {isFullscreen && (
        <LeaderFullscreen
          data={data}
          isWorking={displayStatus === "running"}
          onUpdateData={(next) => emitUpdate(next)}
          onExit={() => setIsFullscreen(false)}
          input={input}
          onInputChange={setInput}
          onPromptSubmit={handlePromptSubmit}
          onPromptKeyDown={handleKeyDown}
          promptPlaceholder={promptPlaceholder}
          promptSubmitLabel={promptSubmitLabel}
          promptSubmitDisabled={promptSubmitDisabled}
          promptSubmitActive={promptSubmitActive}
          onStop={handleStop}
          messageContextSelection={messageContextSelection}
          activateMessageSelection={activateMessageSelection}
          setMessageContextSelection={setMessageContextSelection}
          exitMessageSelection={exitMessageSelection}
          onAddContentNode={onAddContentNode}
          onRevealMinion={(taskIdOrSessionKey) => {
            selectMinionTask(taskIdOrSessionKey);
          }}
          onOpenSkillFlyout={() => setSkillFlyoutOpen(true)}
          graphProjection={taskGraphController.snapshot ? {
            title: taskGraphController.snapshot.title,
            status: taskGraphController.snapshot.status,
            detail: `${taskGraphController.snapshot.nodes.length} graph tasks`,
          } : taskGraphController.planSnapshot ? {
            title: taskGraphController.planSnapshot.objective,
            status: taskGraphController.planSnapshot.state.replace("_", " "),
            detail: `${taskGraphController.planSnapshot.steps.length} planned steps`,
          } : null}
          onOpenGraph={taskGraphController.openInspector}
          skillFlyoutAnchorRef={fullscreenSkillAnchorRef}
          actionsSlot={headerMenu} configSlot={configFooter} minionsSlot={minionsSurface}
          contextItems={getContextForNode?.()}
          dashboardSlot={<DashboardSurface renderState={data.renderState ?? emptyRenderState()} payloadError={renderPayloadError}
            onSubmitForm={handleSubmitForm} onAddContentNode={onAddContentNode} />}
          toolbarSlot={
            <SessionToolbar
              sessionKey={data.sessionKey}
              status={displayStatus}
              model={data.model ?? "opus"}
              permissionMode={data.permissionMode ?? "auto"}
                    onModelChange={handleModelChange}
              onPermissionModeChange={handlePermissionModeChange}
              thinkingConfig={data.thinkingConfig ?? DEFAULT_THINKING_CONFIG}
              onThinkingConfigChange={handleThinkingConfigChange}
              harness={data.harness ?? "claude"}
              onHarnessChange={handleHarnessChange}
              accent="var(--accent)"
            />
          }
          bannerSlot={
            <>
              <StatusBannerStack banners={banners} onDismiss={dismissBanner} />
              {launchNotice ? <div role="status" style={{ padding: "6px 10px", fontSize: 11, background: "var(--warning-bg)", color: "var(--text-primary)" }}>{launchNotice}</div> : null}
            </>
          }
        />
      )}

      {resetConfirmOpen && (
        <ConfirmModal
          title="Reset Leader session?"
          description="All messages in this Leader session will be cleared."
          onClose={() => setResetConfirmOpen(false)}
          actions={[
            {
              label: "Reset",
              variant: "danger",
              onClick: () => {
                setResetConfirmOpen(false);
                resetSession();
              },
            },
          ]}
        />
      )}

      {data.error && (
        <div
          style={{
            padding: "6px 10px",
            background: "var(--danger-bg)",
            color: "var(--status-error)",
            fontSize: 11,
            borderTop: "1px solid var(--danger-color)",
            fontFamily: "var(--font-mono)",
            wordBreak: "break-word",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <span style={{ flex: 1 }}>{data.error}</span>
          <CopyButton
            text={data.fullError ?? data.error}
            layout="inline"
            alwaysVisible
            title="Copy error to clipboard"
          />
          <button
            onClick={() => onUpdateData({ ...data, error: null })}
            style={{
              background: "none",
              border: "none",
              color: "var(--status-error)",
              cursor: "pointer",
              fontSize: 13,
              padding: "0 2px",
              lineHeight: 1,
              flexShrink: 0,
              opacity: 0.7,
            }}
            title="Dismiss error"
            aria-label="Dismiss error"
          >
            x
          </button>
        </div>
      )}
    </div>
    </LeaderSlashCommandsProvider></PromptAttachmentsContext.Provider></CanvasDeliveryContext.Provider></FormSubmissionProvider>
  );
}

registerNodeType({
  type: "leader",
  label: "Leader",
  defaultSize: { width: 560, height: 520 },
  render: LeaderNodeRenderer,
  agentType: "leader",
  ownsChildrenOfType: ["minion"],
  // The embedded dashboard can be exported as context to another Leader,
  // preserving the retired render node's context-out capability.
  providesContext: true,
  extractContent: (data) => {
    const renderState = (data as LeaderData | undefined)?.renderState;
    if (!renderState) return null;
    const text = flattenRenderStateToText(renderState);
    return text.length > 0 ? text : null;
  },
});

// LEADER_DEFAULT_DATA has moved to ./leader/types.ts and is re-exported above.
