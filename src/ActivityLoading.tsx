import "./activity-loading.css";

export interface ActivityLoadingProps {
  loading?: boolean;
  loadError?: string | null;
  onRetryLoad?: (() => void) | undefined;
  connected?: boolean;
}

/** Shared loading feedback; received activity stays interactive beside this status. */
export function ActivityLoading({ loadError, onRetryLoad, connected = true, skeleton = false }: ActivityLoadingProps & {
  skeleton?: boolean;
}) {
  return (
    <div className="activity-loading">
      <div role={loadError ? "alert" : "status"} className="activity-loading-status">
        <span>{loadError ?? (!connected ? "Connecting to activity…"
          : skeleton ? "Loading activity…" : "Loading more activity…")}</span>
        {loadError && onRetryLoad ? <button type="button" onClick={onRetryLoad}>Retry</button> : null}
      </div>
      {skeleton && !loadError ? (
        <div className="activity-loading-rows" aria-hidden="true">
          {[0, 1, 2].map((row) => <div className="activity-loading-row" key={row}>
            <span /><span /><span />
          </div>)}
        </div>
      ) : null}
    </div>
  );
}
