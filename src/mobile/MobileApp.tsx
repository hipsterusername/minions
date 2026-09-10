import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Bell, BellRing, ChevronLeft, Plus, Settings } from "lucide-react";

import { listProjects, type ProjectSummary } from "../api.ts";
import { useSocket } from "../use-socket.ts";
import { HarnessListProvider } from "../use-harness-list.tsx";
import { useSessionActivity } from "../use-session-activity.ts";
import { mergeCanonicalActivity, useWorkItems } from "../use-work-items.ts";
import { ActivityScreen, type ActivityViewMemory } from "./ActivityScreen.tsx";
import type { ActivityNotice } from "./ActivityScreen.tsx";
import { LaunchScreen } from "./LaunchScreen.tsx";
import { ProjectsScreen } from "./ProjectsScreen.tsx";
import { ReviewChangesScreen } from "./ReviewChangesScreen.tsx";
import { SettingsScreen } from "./SettingsScreen.tsx";
import { SessionChatScreen, type SessionViewMemory } from "./SessionChatScreen.tsx";
import {
  pendingApprovalsList,
  reduceApprovalMessage,
  type PendingApprovalsMap,
} from "./mobile-approvals.ts";
import { sessionDisplayTitle, sessionBelongsToProject } from "./mobile-selectors.ts";
import {
  disablePush,
  enablePush,
  getPushState,
  isPushSupported,
  registerServiceWorker,
} from "./push.ts";
import { useMobileKeyboard } from "./use-mobile-keyboard.ts";
import { buildWsUrl } from "../ws-url.ts";
import { applyTheme } from "../themes.ts";
import { loadPersistedThemeId } from "../use-theme.ts";
import "./mobile.css";

import { mobileRouteFromUrl, useMobileNavigation, type ProjectScope } from "./use-mobile-navigation.ts";

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
      title={label}
    >
      {compact ? (state === "subscribed" ? <BellRing size={18} aria-hidden="true" /> : <Bell size={18} aria-hidden="true" />) : label}
    </button>
  );
}

function MobileHeader({ connected, reconnectState, selectedProject, activeTab, onBack,
  onReconnect, onSettings, onNew }: {
  connected: boolean; reconnectState: string; selectedProject: ProjectScope | null;
  activeTab: string; onBack: () => void; onReconnect: () => void;
  onSettings: () => void; onNew: () => void;
}) {
  const atHome = activeTab === "activity";
  return <header className="mob-app-header">
    <div className="mob-app-header-main">
      {selectedProject ? <button type="button" className="mob-header-back" onClick={onBack}
        aria-label={atHome ? "Back to projects" : "Back to activity"}>
        <ChevronLeft size={20} aria-hidden="true" />
      </button> : null}
      <div className="mob-app-title">
        <span>{selectedProject ? atHome ? "Project" : activeTab === "launch" ? "New task" : "Settings" : "Projects"}</span>
        <strong title={selectedProject?.path}>{selectedProject?.name ?? "Minions"}</strong>
      </div>
    </div>
    <div className="mob-app-header-actions">
      <span className="mob-connection-dot" data-state={reconnectState} role="status"
        aria-label={connected ? "Connected" : reconnectState} title={connected ? "Connected" : reconnectState} />
      {reconnectState === "failed" ? <button type="button" className="mob-header-action" onClick={onReconnect}>Reconnect</button> : <NotificationsButton compact />}
      {selectedProject && atHome ? <>
        <button type="button" className="mob-header-action" onClick={onSettings} aria-label="Settings"><Settings size={18} aria-hidden="true" /></button>
        <button type="button" className="mob-header-action mob-primary-action" onClick={onNew} aria-label="New"><Plus size={18} aria-hidden="true" /></button>
      </> : null}
    </div>
  </header>;
}

export default function MobileApp() {
  // The mobile route bypasses App, which initializes the desktop theme.
  // Apply the same saved palette and skin before the first mobile paint.
  useLayoutEffect(() => {
    applyTheme(loadPersistedThemeId());
  }, []);

  const { connected, send, subscribe, reconnectState, manualReconnect } = useSocket(buildWsUrl());
  const keyboard = useMobileKeyboard();
  const { sessions, mobileSessions, hasLoaded: sessionsLoaded } = useSessionActivity(subscribe);
  const { route, navigate, backToActivity: openActivity, closeGraph } = useMobileNavigation();
  const { project: selectedProject, sessionKey: selectedSessionKey, screen: activeTab } = route;
  const activityMemories = useRef(new Map<string, ActivityViewMemory>());
  const sessionMemories = useRef(new Map<string, SessionViewMemory>());
  const [lastSessionKey, setLastSessionKey] = useState<string | null>(null);
  const workItemState = useWorkItems({ projectId: selectedProject?.id ?? null,
    connected, subscribe, send });
  const canonicalSessions = useMemo(
    () => mergeCanonicalActivity(mobileSessions, workItemState.orderedItems,
      workItemState.coordination),
    [mobileSessions, workItemState.orderedItems, workItemState.coordination],
  );
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

  const selectedApproval = approvalRows.find((approval) => approval.sessionKey === selectedSessionKey);
  const selectProject = useCallback((project: ProjectSummary) => {
    navigate({ project: { id: project.id, path: project.path, name: project.name }, screen: "activity", sessionKey: null, view: "chat" });
  }, [navigate]);
  const backToProjects = useCallback(() => {
    navigate({ project: null, screen: "activity", sessionKey: null, view: "chat" });
  }, [navigate]);
  const openSession = useCallback((sessionKey: string) => {
    setLastSessionKey(sessionKey);
    navigate({ ...route, screen: "chat", sessionKey, view: "chat" });
  }, [navigate, route]);
  const handleLaunchSubmitted = useCallback((sessionKey: string) => {
    setPendingLaunchSessionKey(sessionKey);
    setActivityNotice(null);
    openSession(sessionKey);
  }, [openSession]);
  const openLaunch = useCallback(() => {
    navigate({ ...route, screen: "launch", sessionKey: null, view: "chat" });
  }, [navigate, route]);
  const openSettings = useCallback(() => {
    navigate({ ...route, screen: "settings", sessionKey: null, view: "chat" });
  }, [navigate, route]);

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
    openActivity();
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
  }, [dismissActivityNotice, openSessionToStopForLimit, sessionToStopForLimit, openActivity]);

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
    setLastSessionKey(sessionKey);
    navigate({ ...route, screen: "chat", sessionKey, view: "changes" });
  }, [navigate, route]);

  const applyMobileUrl = useCallback((url: string) => {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin !== window.location.origin || !parsed.searchParams.get("session")) return;
    const next = mobileRouteFromUrl(url);
    navigate(next);
  }, [navigate]);

  // Deep links recover their project from current metadata, including sessions
  // whose worktree lives outside the source repository. Reject stale project IDs.
  const requestedProjectId = new URL(window.location.href).searchParams.get("project");
  useEffect(() => {
    if (selectedProject || (!selectedSession && !requestedProjectId)) return;
    let cancelled = false;
    void listProjects().then((projects) => {
      if (cancelled) return;
      const project = projects.find((candidate) => selectedSession
        ? sessionBelongsToProject(selectedSession, candidate.path, candidate.id)
        : candidate.id === requestedProjectId);
      if (project) navigate({ ...route, project }, true);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [selectedProject, selectedSession, requestedProjectId, navigate, route]);

  useEffect(() => {
    if (!isPushSupported()) return;

    void registerServiceWorker().catch(() => {});
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    function handleServiceWorkerMessage(event: MessageEvent<unknown>) {
      if (!isPushNavigateMessage(event.data)) return;
      applyMobileUrl(event.data.url);
    }

    navigator.serviceWorker.addEventListener("message", handleServiceWorkerMessage);
    return () => {
      navigator.serviceWorker.removeEventListener("message", handleServiceWorkerMessage);
    };
  }, [applyMobileUrl]);

  const showingActiveSession = activeTab === "chat" && selectedSessionKey !== null;
  const activityKey = selectedProject?.id ?? "projects";
  if (!activityMemories.current.has(activityKey)) activityMemories.current.set(activityKey, {});
  if (selectedSessionKey && !sessionMemories.current.has(selectedSessionKey)) sessionMemories.current.set(selectedSessionKey, {});
  const resumableSession = scopedSessions.find((session) => session.sessionKey === lastSessionKey);
  const activitySessions = scopedSessions.map((session) => scopedApprovalRows.some((approval) => approval.sessionKey === session.sessionKey)
    ? { ...session, pendingAttention: true, reviewableChanges: true } : session);
  const unavailable = sessionsLoaded && !(selectedProject && workItemState.loading) && !selectedSession && pendingLaunchSessionKey !== selectedSessionKey;

  return (
    <HarnessListProvider send={send} subscribe={subscribe} connected={connected}>
    <div className="mob-app" data-keyboard={keyboard.open ? "open" : "closed"}
      style={{
        "--mob-keyboard-offset": `${keyboard.open ? 0 : keyboard.offset}px`,
        "--mob-viewport-height": `${keyboard.height}px`,
        "--mob-viewport-top": `${keyboard.top}px`,
      } as CSSProperties}>
      {showingActiveSession ? null : <MobileHeader connected={connected} reconnectState={reconnectState}
        selectedProject={selectedProject} activeTab={activeTab}
        onBack={activeTab === "activity" ? backToProjects : openActivity}
        onReconnect={manualReconnect} onSettings={openSettings} onNew={openLaunch} />}

      {showingActiveSession ? (
        <SessionChatScreen key={selectedSessionKey} sessionKey={selectedSessionKey}
          session={selectedSession} sessionOptions={scopedSessions}
          subscribe={subscribe} send={send} onBack={openActivity} onSelectSession={openSession}
          projectName={selectedProject?.name ?? selectedSession?.cwd?.split("/").filter(Boolean).at(-1)}
          connected={connected} reconnectState={reconnectState} onReconnect={manualReconnect}
          view={route.view} onCloseGraph={closeGraph} onViewChange={(view) => navigate({ ...route, view })}
          memory={sessionMemories.current.get(selectedSessionKey)!}
          unavailable={unavailable} loading={!selectedSession && !unavailable}
          changeMode={selectedSession?.workItemId ? workItemState.items[selectedSession.workItemId]?.lifecycle.changeMode : undefined}
          approval={selectedApproval} onOpenReview={() => openReview(selectedSessionKey)}
          changes={selectedSession ? (
            selectedSession.workItemId && !workItemState.items[selectedSession.workItemId] ? (
              <div className="mob-empty" role="status"><h2>Loading change details</h2>
                <p>{workItemState.loadError ?? "Retrieving the current work item."}</p>
                {workItemState.loadError ? <button className="mob-header-action" onClick={workItemState.retryLoad}>Retry</button> : null}
              </div>
            ) : <ReviewChangesScreen embedded approvalPending={Boolean(selectedApproval)} sessionKey={selectedSessionKey}
              workItemId={selectedSession.workItemId ?? null}
              changeMode={selectedSession.workItemId ? workItemState.items[selectedSession.workItemId]?.lifecycle.changeMode : undefined}
              onRequestChanges={(prompt) => {
                const item = selectedSession.workItemId ? workItemState.items[selectedSession.workItemId] : undefined;
                if (!item) return false;
                workItemState.start(item, prompt);
                return true;
              }}
              onClose={() => navigate({ ...route, view: "chat" })}
              send={send} subscribe={subscribe} summary={selectedApproval?.summary}
              title={sessionDisplayTitle(selectedSession)} />
          ) : undefined} />
      ) : !selectedProject ? (
        <ProjectsScreen sessions={mobileSessions} onSelectProject={selectProject} />
      ) : activeTab === "launch" ? (
        <LaunchScreen onLaunched={handleLaunchSubmitted}
          onLaunchError={(message) => { if (/Maximum session limit/i.test(message)) showSessionLimitNotice(); }}
          canonicalLaunch={workItemState.launch} lockedProject={selectedProject} />
      ) : activeTab === "settings" ? (
        <SettingsScreen project={selectedProject} sessions={scopedSessions} send={send} subscribe={subscribe} />
      ) : (
        <ActivityScreen key={activityKey} memory={activityMemories.current.get(activityKey)!}
          resumeSession={resumableSession} onOpenReview={openReview}
          approvalSessionKeys={scopedApprovalRows.map((approval) => approval.sessionKey)}
          loading={!sessionsLoaded || workItemState.loading} loadError={workItemState.loadError}
          onRetryLoad={workItemState.retryLoad} connected={connected} sessions={activitySessions}
          onOpenSession={openSession} onNewLeader={openLaunch} notice={activityNotice} send={send}
          workItemRuns={workItemState.runs} runNextCursor={workItemState.runNextCursor}
          onLoadRuns={workItemState.loadRuns} />
      )}
    </div>
    </HarnessListProvider>
  );
}
