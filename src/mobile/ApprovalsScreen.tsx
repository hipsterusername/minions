import {
  formatDiffStat,
  type PendingApproval,
} from "./mobile-approvals.ts";

interface ApprovalsScreenProps {
  approvals: PendingApproval[];
  onOpenReview: (sessionKey: string) => void;
}

export function ApprovalsScreen({
  approvals,
  onOpenReview,
}: ApprovalsScreenProps) {
  if (approvals.length === 0) {
    return (
      <main className="mob-screen mob-approvals" aria-label="Approvals">
        <div className="mob-empty">
          <h1>Approvals</h1>
          <p>No sessions are awaiting approval.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="mob-screen mob-approvals" aria-label="Approvals">
      <header className="mob-screen-header">
        <h1>Approvals</h1>
        <span className="mob-count">{approvals.length}</span>
      </header>
      <div className="mob-approval-list">
        {approvals.map((approval) => (
          <button
            className="mob-approval-card"
            key={approval.sessionKey}
            onClick={() => onOpenReview(approval.sessionKey)}
            type="button"
          >
            <span className="mob-approval-title">
              {approval.sessionTitle ?? approval.sessionKey}
            </span>
            <span className="mob-approval-summary">{approval.summary}</span>
            <span className="mob-approval-stat">{formatDiffStat(approval.diff)}</span>
          </button>
        ))}
      </div>
    </main>
  );
}
