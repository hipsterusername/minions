import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Activity, CheckSquare2, MessageSquare, Plus, Settings } from "lucide-react";

import type { ProjectSummary } from "../api.ts";
import { useSocket } from "../use-socket.ts";
import { HarnessListProvider } from "../use-harness-list.tsx";
import { useSessionActivity } from "../use-session-activity.ts";
import { mergeCanonicalActivity, useWorkItems } from "../use-work-items.ts";
import { ActivityScreen } from "./ActivityScreen.tsx";
import type { ActivityNotice } from "./ActivityScreen.tsx";
import { ApprovalsScreen } from "./ApprovalsScreen.tsx";
import { LaunchScreen } from "./LaunchScreen.tsx";
import { ProjectsScreen } from "./ProjectsScreen.tsx";
import { ReviewChangesScreen } from "./ReviewChangesScreen.tsx";
import { SettingsScreen } from "./SettingsScreen.tsx";
import { SessionChatScreen } from "./SessionChatScreen.tsx";
import {
  pendingApprovalsList,
  reduceApprovalMessage,
  type PendingApprovalsMap,
} from "./mobile-approvals.ts";
import { needsAttention, sessionBelongsToProject } from "./mobile-selectors.ts";
import {
  disablePush,
  enablePush,
  getPushState,
  isPushSupported,
  registerServiceWorker,
} from "./push.ts";
import { useMobileKeyboard } from "./use-mobile-keyboard.ts";
import { buildWsUrl } from "../ws-url.ts";
import "./mobile.css";

type MobileTab = "activity" | "approvals" | "chat" | "launch" | "settings";
/** The project the mobile app is currently scoped to. */
interface ProjectScope {
  id: string;
  path: string;
  name: string;
}
type PushUiState = "loading" | "subscribed" | "default" | "denied" | "unsupported" | "error";

interface PushNavigateMessage {
  type: "push-navigate";
  url: string;
}

function isPushNavigateMessage(value: unknown): value is PushNavigateMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "push-navigate" &&
    "url" in value &&
    typeof value.url === "string"
  );
}

function NotificationsButton({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<PushUiState>("loading");
  const [busy, setBusy] = useState(false);

  const refreshState = useCallback(() => {
    if (!isPushSupported()) {
      setState("unsupported");
      return;
    }

    void getPushState()
      .then(setState)
      .catch(() => setState("error"));
  }, []);

  useEffect(() => {
    refreshState();
  }, [refreshState]);

  const label = useMemo(() => {
    if (busy) return "Notifications...";
    switch (state) {
      case "subscribed":
        return "Notifications On";
      case "denied":
        return "Notifications Blocked";
      case "unsupported":
        return "Notifications Unsupported";
      case "error":
        return "Notifications Error";
      case "loading":
        return "Notifications...";
      case "default":
        return "Enable notifications";
    }
  }, [busy, state]);

  const disabled = busy || state === "loading" || state === "denied" || state === "unsupported";

  const handleClick = useCallback(() => {
    if (disabled) return;

    setBusy(true);
    const action = state === "subscribed" ? disablePush() : enablePush();
    void action
      .then((result) => {
        if (result === "unsupported") {
          setState("unsupported");
          return;
        }
        if (result === "denied") {
          setState("denied");
          return;
        }
        refreshState();
      })
      .catch(() => setState("error"))
      .finally(() => setBusy(false));
  }, [disabled, refreshState, state]);

  return (
    <button
      type="button"
      className="mob-notifications-button"
      disabled={disabled}
      onClick={handleClick}
      aria-label={state === "subscribed" ? "Disable notifications" : "Enable notifications"}
    >
      {compact ? "Alerts" : label}
    </button>
  );
}

function viewTitle(input: {
  selectedProject: ProjectScope | null;
  selectedReviewSessionKey: string | null;
  selectedSessionKey: string | null;
  activeTab: MobileTab;
}): string {
  if (!input.selectedProject) return "Projects";
  if (input.selectedReviewSessionKey) return "Review";
  if (input.activeTab === "chat" && input.selectedSessionKey) return "Session";
  switch (input.activeTab) {
    case "activity":
      return "Activity";
    case "approvals":
      return "Review";
    case "launch":
      return "New";
    case "settings":
      return "Settings";
    case "chat":
      return "Session";
  }
}

function MobileHeader({
  connected,
  reconnectState,
  selectedProject,
  selectedReviewSessionKey,
  selectedSessionKey,
  activeTab,
  onBackToProjects,
  onReconnect,
}: {
  connected: boolean;
  reconnectState: string;
  selectedProject: ProjectScope | null;
  selectedReviewSessionKey: string | null;
  selectedSessionKey: string | null;
  activeTab: MobileTab;
  onBackToProjects: () => void;
  onReconnect: () => void;
}) {
  const title = viewTitle({
    selectedProject,
    selectedReviewSessionKey,
    selectedSessionKey,
    activeTab,
  });
  const statusLabel = connected ? "Connected" : reconnectState;

  return (
    <header className="mob-app-header">
      <div className="mob-app-header-main">
        {selectedProject && !selectedReviewSessionKey ? (
          <button
            type="button"
            className="mob-header-back"
            onClick={onBackToProjects}
            aria-label="Back to projects"
          >
            ‹
          </button>
        ) : null}
        <div className="mob-app-title">
          <span>{title}</span>
          {selectedProject ? (
            <strong title={selectedProject.path}>{selectedProject.name}</strong>
          ) : (
            <strong>Minions</strong>
          )}
        </div>
      </div>
      <div className="mob-app-header-actions">
        <span className="mob-connection-pill" data-state={reconnectState} role="status" aria-live="polite">
          {statusLabel}
        </span>
        {reconnectState === "failed" ? (
          <button type="button" className="mob-header-action" onClick={onReconnect}>
            Reconnect
          </button>
        ) : (
          <NotificationsButton compact />
        )}
      </div>
    </header>
  );
}

export default function MobileApp() {
  const { connected, send, subscribe, reconnectState, manualReconnect } = useSocket(buildWsUrl());
  const keyboard = useMobileKeyboard();
  const { sessions, mobileSessions } = useSessionActivity(subscribe);
  const [selectedProject, setSelectedProject] = useState<ProjectScope | null>(null);
  const workItemState = useWorkItems({ projectId: selectedProject?.id ?? null,
    connected, subscribe, send });
  const canonicalSessions = useMemo(
    () => mergeCanonicalActivity(mobileSessions, workItemState.orderedItems,
      workItemState.coordination),
    [mobileSessions, workItemState.orderedItems, workItemState.coordination],
  );
  const [selectedSessionKey, setSelectedSessionKey] = useState<string | null>(null);
  const [selectedReviewSessionKey, setSelectedReviewSessionKey] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<MobileTab>("activity");
  const [pendingApprovals, setPendingApprovals] = useState<PendingApprovalsMap>({});
  const [pendingLaunchSessionKey, setPendingLaunchSessionKey] = useState<string | null>(null);
  const [activityNotice, setActivityNotice] = useState<ActivityNotice | null>(null);

  useEffect(() => {
    return subscribe("*", (msg) => {
      setPendingApprovals((current) => reduceApprovalMessage(current, msg));
    });
  }, [subscribe]);

  useEffect(() => {
    if (activeTab !== "activity" || !connected) return;
    send({ type: "list_sessions" });
  }, [activeTab, connected, send]);

  const selectedSession = canonicalSessions.find((session) => session.sessionKey === selectedSessionKey);

  // Once a project is chosen, every list screen is scoped to it. Sessions are
  // matched by stable workspace identity plus source/worktree location (see
  // sessionBelongsToProject), keeping centrally isolated leaders grouped with
  // their originating project.
  const scopedSessions = useMemo(
    () =>
      selectedProject
        ? canonicalSessions.filter((session) =>
            sessionBelongsToProject(session, selectedProject.path, selectedProject.id),
          )
        : canonicalSessions,
    [canonicalSessions, selectedProject],
  );

  const approvalRows = useMemo(
    () => pendingApprovalsList(pendingApprovals, sessions),
    [pendingApprovals, sessions],
  );
  const scopedApprovalRows = useMemo(() => {
    if (!selectedProject) return approvalRows;
    const scopedKeys = new Set(scopedSessions.map((session) => session.sessionKey));
    return approvalRows.filter((approval) => scopedKeys.has(approval.sessionKey));
  }, [approvalRows, scopedSessions, selectedProject]);
  const sessionToStopForLimit = useMemo(
    () =>
      scopedSessions.find((session) =>
        session.role !== "minion" &&
        session.status !== "stopped" &&
        (session.status === "idle" ||
          session.status === "error" ||
          session.status === "completed")
      ) ??
      scopedSessions.find((session) =>
        session.role !== "minion" && session.status !== "stopped"
      ) ??
      null,
    [scopedSessions],
  );

  const selectedApproval = selectedReviewSessionKey
    ? approvalRows.find((approval) => approval.sessionKey === selectedReviewSessionKey)
    : undefined;
  const selectedReviewSession = selectedReviewSessionKey
    ? canonicalSessions.find((session) => session.sessionKey === selectedReviewSessionKey)
    : undefined;
  const approvalCount = scopedApprovalRows.length;
  const attentionCount = scopedSessions.filter(
    (session) => session.role !== "minion" && needsAttention(session),
  ).length;

  const selectProject = useCallback((project: ProjectSummary) => {
    setSelectedProject({ id: project.id, path: project.path, name: project.name });
    setSelectedSessionKey(null);
    setSelectedReviewSessionKey(null);
    setActiveTab("activity");
  }, []);

  const backToProjects = useCallback(() => {
    setSelectedProject(null);
    setSelectedSessionKey(null);
    setSelectedReviewSessionKey(null);
    setActiveTab("activity");
  }, []);

  const openSession = useCallback((sessionKey: string) => {
    setSelectedSessionKey(sessionKey);
    setSelectedReviewSessionKey(null);
    setActiveTab("chat");
  }, []);

  const handleLaunchSubmitted = useCallback((sessionKey: string) => {
    setPendingLaunchSessionKey(sessionKey);
    setActivityNotice(null);
    openSession(sessionKey);
  }, [openSession]);

  const openApprovals = useCallback(() => {
    setSelectedReviewSessionKey(null);
    setActiveTab("approvals");
  }, []);

  const openLaunch = useCallback(() => {
    setSelectedReviewSessionKey(null);
    setActiveTab("launch");
  }, []);

  const openSettings = useCallback(() => {
    setSelectedReviewSessionKey(null);
    setActiveTab("settings");
  }, []);

  const openActivity = useCallback(() => {
    setSelectedReviewSessionKey(null);
    setActiveTab("activity");
  }, []);

  const dismissActivityNotice = useCallback(() => {
    setActivityNotice(null);
  }, []);

  const openSessionToStopForLimit = useCallback(() => {
    if (!sessionToStopForLimit) return;
    setActivityNotice(null);
    openSession(sessionToStopForLimit.sessionKey);
  }, [openSession, sessionToStopForLimit]);

  const showSessionLimitNotice = useCallback(() => {
    setPendingLaunchSessionKey(null);
    setSelectedSessionKey(null);
    setSelectedReviewSessionKey(null);
    setActiveTab("activity");
    const notice: ActivityNotice = {
      title: "Session limit reached",
      message:
        "Minions already has 50 non-stopped sessions. Open an idle or errored session and tap Stop, or remove old sessions on desktop, then launch again.",
      onDismiss: dismissActivityNotice,
    };
    if (sessionToStopForLimit) {
      notice.actionLabel = "Open session to stop";
      notice.onAction = openSessionToStopForLimit;
    }
    setActivityNotice(notice);
  }, [dismissActivityNotice, openSessionToStopForLimit, sessionToStopForLimit]);

  useEffect(() => {
    return subscribe("*", (msg) => {
      if (msg.type === "session_created" && msg.sessionKey === pendingLaunchSessionKey) {
        setPendingLaunchSessionKey(null);
        return;
      }

      if (
        msg.type !== "session_error" ||
        !/Maximum session limit/i.test(msg.error) ||
        (pendingLaunchSessionKey !== null && msg.sessionKey !== pendingLaunchSessionKey)
      ) {
        return;
      }

      showSessionLimitNotice();
    });
  }, [
    pendingLaunchSessionKey,
    sessionToStopForLimit,
    showSessionLimitNotice,
    subscribe,
  ]);

  const openReview = useCallback((sessionKey: string) => {
    setSelectedReviewSessionKey(sessionKey);
    setActiveTab("approvals");
  }, []);

  const applyMobileUrl = useCallback((url: string, updateHistory: boolean) => {
    const parsed = new URL(url, window.location.origin);
    const sessionKey = parsed.searchParams.get("session");
    if (!sessionKey) return;

    setSelectedSessionKey(sessionKey);
    if (parsed.searchParams.get("review") === "1") {
      setSelectedReviewSessionKey(sessionKey);
      setActiveTab("approvals");
    } else {
      setSelectedReviewSessionKey(null);
      setActiveTab("chat");
    }

    if (updateHistory) {
      window.history.replaceState(null, "", `${parsed.pathname}${parsed.search}${parsed.hash}`);
    }
  }, []);

  useEffect(() => {
    if (!isPushSupported()) return;

    void registerServiceWorker().catch(() => {});
  }, []);

  useEffect(() => {
    applyMobileUrl(window.location.href, false);
  }, [applyMobileUrl]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    function handleServiceWorkerMessage(event: MessageEvent<unknown>) {
      if (!isPushNavigateMessage(event.data)) return;
      applyMobileUrl(event.data.url, true);
    }

    navigator.serviceWorker.addEventListener("message", handleServiceWorkerMessage);
    return () => {
      navigator.serviceWorker.removeEventListener("message", handleServiceWorkerMessage);
    };
  }, [applyMobileUrl]);

  const showingActiveSession = activeTab === "chat" && selectedSessionKey !== null;

  return (
    <HarnessListProvider send={send} subscribe={subscribe} connected={connected}>
    <div
      className="mob-app"
      data-keyboard={keyboard.open ? "open" : "closed"}
      style={{ "--mob-keyboard-offset": `${keyboard.offset}px` } as CSSProperties}
    >
      {showingActiveSession ? null : (
        <MobileHeader
          connected={connected}
          reconnectState={reconnectState}
          selectedProject={selectedProject}
          selectedReviewSessionKey={selectedReviewSessionKey}
          selectedSessionKey={selectedSessionKey}
          activeTab={activeTab}
          onBackToProjects={backToProjects}
          onReconnect={manualReconnect}
        />
      )}

      {selectedReviewSessionKey ? (
        <ReviewChangesScreen
          sessionKey={selectedReviewSessionKey}
          workItemId={selectedReviewSession?.workItemId ?? null}
          changeMode={selectedReviewSession?.workItemId
            ? workItemState.items[selectedReviewSession.workItemId]?.lifecycle.changeMode
            : undefined}
          onRequestChanges={(prompt) => {
            const workItemId = selectedReviewSession?.workItemId;
            const item = workItemId ? workItemState.items[workItemId] : undefined;
            if (!item) return false;
            workItemState.start(item, prompt);
            return true;
          }}
          send={send}
          subscribe={subscribe}
          onClose={() => setSelectedReviewSessionKey(null)}
          summary={selectedApproval?.summary}
          title={selectedApproval?.sessionTitle}
        />
      ) : activeTab === "chat" && selectedSessionKey ? (
        <SessionChatScreen
          sessionKey={selectedSessionKey}
          session={selectedSession}
          sessionOptions={scopedSessions}
          subscribe={subscribe}
          send={send}
          onBack={openActivity}
          onSelectSession={openSession}
        />
      ) : !selectedProject ? (
        <ProjectsScreen sessions={mobileSessions} onSelectProject={selectProject} />
      ) : activeTab === "approvals" ? (
        <ApprovalsScreen approvals={scopedApprovalRows} onOpenReview={openReview} />
      ) : activeTab === "launch" ? (
        <LaunchScreen send={send} onLaunched={handleLaunchSubmitted}
          onLaunchError={(message) => {
            if (/Maximum session limit/i.test(message)) showSessionLimitNotice();
          }}
          canonicalLaunch={workItemState.launch} lockedProject={selectedProject} />
      ) : activeTab === "settings" ? (
        <SettingsScreen
          project={selectedProject}
          sessions={scopedSessions}
          send={send}
          subscribe={subscribe}
        />
      ) : (
        <ActivityScreen
          sessions={scopedSessions}
          onOpenSession={openSession}
          notice={activityNotice}
          send={send}
          workItemRuns={workItemState.runs}
          runNextCursor={workItemState.runNextCursor}
          onLoadRuns={workItemState.loadRuns}
        />
      )}

      {selectedReviewSessionKey || !selectedProject ? null : (
      <nav className="mob-tabbar" aria-label="Mobile navigation">
        <button
          type="button"
          className={activeTab === "activity" ? "mob-tabbar-button mob-tabbar-button--active" : "mob-tabbar-button"}
          onClick={openActivity}
          aria-current={activeTab === "activity" ? "page" : undefined}
          aria-label={attentionCount > 0 ? `Activity, ${attentionCount} need you` : "Activity"}
        >
          <Activity size={18} aria-hidden="true" />
          <span>Activity</span>
          {attentionCount > 0 ? <span className="mob-tab-badge">{attentionCount}</span> : null}
        </button>
        <button
          type="button"
          className={activeTab === "chat" && selectedSessionKey ? "mob-tabbar-button mob-tabbar-button--active" : "mob-tabbar-button"}
          disabled={!selectedSessionKey}
          onClick={() => setActiveTab("chat")}
          aria-current={activeTab === "chat" && selectedSessionKey ? "page" : undefined}
        >
          <MessageSquare size={18} aria-hidden="true" />
          <span>Chat</span>
        </button>
        <button
          type="button"
          className={activeTab === "approvals" ? "mob-tabbar-button mob-tabbar-button--active" : "mob-tabbar-button"}
          onClick={openApprovals}
          aria-current={activeTab === "approvals" ? "page" : undefined}
          aria-label={approvalCount > 0 ? `Approvals, ${approvalCount} pending` : "Approvals"}
        >
          <CheckSquare2 size={18} aria-hidden="true" />
          <span>Review</span>
          {approvalCount > 0 ? <span className="mob-tab-badge">{approvalCount}</span> : null}
        </button>
        <button
          type="button"
          className={activeTab === "launch" ? "mob-tabbar-button mob-tabbar-button--active" : "mob-tabbar-button"}
          onClick={openLaunch}
          aria-current={activeTab === "launch" ? "page" : undefined}
        >
          <Plus size={18} aria-hidden="true" />
          <span>New</span>
        </button>
        <button
          type="button"
          className={activeTab === "settings" ? "mob-tabbar-button mob-tabbar-button--active" : "mob-tabbar-button"}
          onClick={openSettings}
          aria-current={activeTab === "settings" ? "page" : undefined}
        >
          <Settings size={18} aria-hidden="true" />
          <span>Settings</span>
        </button>
      </nav>
      )}
    </div>
    </HarnessListProvider>
  );
}
