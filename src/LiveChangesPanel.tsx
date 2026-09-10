import type { SocketSubscribeLike } from "./use-socket.ts";
import { useReviewDiff } from "./use-review-diff.ts";
import { ChangesRefreshIndicator } from "./ChangesRefreshIndicator.tsx";
import "./changes-view.css";

export function LiveChangesPanel({ sessionKey, send, subscribe }: {
  sessionKey: string;
  send: ((data: unknown) => void) | undefined;
  subscribe: SocketSubscribeLike;
}) {
  const { diff, loading, error, loadedAt, refresh } = useReviewDiff(sessionKey, send, subscribe);
  return <section className="changes-card changes-card--inline live-changes" aria-label="Workspace changes">
    <div className="live-changes__header">
      <div className="changes-card__stats">
        {diff ? <>{diff.filesChanged} file{diff.filesChanged === 1 ? "" : "s"} · <span className="changes-add">+{diff.insertions}</span> <span className="changes-del">-{diff.deletions}</span></> : "Workspace changes"}
      </div>
      <ChangesRefreshIndicator loading={loading} />
    </div>
    <p className="changes-card__disclaimer">Includes all uncommitted edits from agents, you, and other tools. Changes can’t be attributed to individual agents.</p>
    {error && <p className="live-changes__error" role="alert">Couldn’t load changes: {error}</p>}
    {diff && <>
      {diff.filesChanged === 0 && <p className="live-changes__empty">No uncommitted changes.</p>}
      {diff.filesChanged > 0 && <div className="changes-card__files">
        {diff.files.map(file => <div className="changes-file" key={file.file}>
          <span className="changes-file__status" data-status={file.status} title={file.status}>{file.status === "added" ? "A" : file.status === "deleted" ? "D" : "M"}</span>
          <span className="changes-file__path" title={file.file}>{file.file}</span>
          <span className="changes-add">+{file.insertions}</span>
          <span className="changes-del">-{file.deletions}</span>
        </div>)}
      </div>}
    </>}
    <div className="live-changes__footer">
      <span className="live-changes__updated">{loadedAt !== null ? `Last loaded ${new Date(loadedAt).toLocaleTimeString()}` : "Not loaded yet"}</span>
      <button className="changes-btn" type="button" onClick={refresh} disabled={loading}>{error ? "Retry" : "Refresh"}</button>
    </div>
  </section>;
}
