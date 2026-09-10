import { RefreshCw } from "lucide-react";

/** Keep the slot mounted so polling never moves the surrounding content. */
export function ChangesRefreshIndicator({ loading }: { loading: boolean }) {
  return <span className="changes-refresh" data-loading={loading} role="status"
    aria-label={loading ? "Refreshing changes" : undefined}>
    <RefreshCw size={13} strokeWidth={1.75} className="changes-spin" aria-hidden />
  </span>;
}
