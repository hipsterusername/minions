import { useState, useEffect, useRef, useCallback } from "react";
import type { SdkMessage } from "../use-socket.ts";

// ── Banner types ────────────────────────────────────────

export type BannerKind = "rate_limit" | "retry" | "compaction" | "warning";

export interface StatusBannerItem {
  id: string;
  kind: BannerKind;
  message: string;
  detail?: string;
  timestamp: number;
  /** Auto-dismiss after this many ms (0 = manual dismiss) */
  ttl: number;
}

let bannerIdCounter = 0;
function nextBannerId(): string {
  bannerIdCounter += 1;
  return `sb-${bannerIdCounter}`;
}

// ── Banner config per kind ──────────────────────────────

const BANNER_CONFIG: Record<
  BannerKind,
  { icon: string; color: string; bg: string; border: string }
> = {
  rate_limit: {
    icon: "\u29D7", // hourglass
    color: "var(--warning-color)",
    bg: "var(--warning-bg)",
    border: "var(--warning-bg)",
  },
  retry: {
    icon: "\u21BB", // clockwise arrow
    color: "var(--priority-high)",
    bg: "var(--warning-bg)",
    border: "var(--warning-bg)",
  },
  compaction: {
    icon: "\u2026", // ellipsis
    color: "var(--tool-accent)",
    bg: "var(--tool-bg)",
    border: "var(--tool-bg)",
  },
  warning: {
    icon: "\u26A0", // warning triangle
    color: "var(--status-error)",
    bg: "var(--danger-bg)",
    border: "var(--danger-bg)",
  },
};

// ── Hook: classify SDK events into banners ──────────────

export function classifySdkEvent(sdkMsg: SdkMessage): StatusBannerItem | null {
  const now = Date.now();

  // ── rate_limit_event ──
  if (sdkMsg.type === "rate_limit_event" && sdkMsg.rate_limit_info) {
    const info = sdkMsg.rate_limit_info;
    if (info.status === "rejected") {
      const resetsAt = info.resetsAt;
      const waitStr = resetsAt
        ? ` Resets ${new Date(resetsAt).toLocaleTimeString()}`
        : "";
      return {
        id: nextBannerId(),
        kind: "rate_limit",
        message: `Rate limited (${info.rateLimitType ?? "unknown"}).${waitStr}`,
        detail: info.utilization != null ? `${Math.round(info.utilization * 100)}% utilized` : undefined,
        timestamp: now,
        ttl: resetsAt ? Math.min(resetsAt - now + 2000, 120000) : 30000,
      };
    }
    if (info.status === "allowed_warning") {
      return {
        id: nextBannerId(),
        kind: "warning",
        message: `Approaching rate limit (${Math.round((info.surpassedThreshold ?? info.utilization ?? 0) * 100)}%)`,
        detail: info.rateLimitType ?? undefined,
        timestamp: now,
        ttl: 10000,
      };
    }
    return null;
  }

  // ── api_retry (system subtype) ──
  if (sdkMsg.type === "system" && sdkMsg.subtype === "api_retry") {
    const attemptStr = sdkMsg.attempt != null ? ` (${sdkMsg.attempt}/${sdkMsg.max_retries})` : "";
    const delayStr = sdkMsg.retry_delay_ms ? ` in ${(sdkMsg.retry_delay_ms / 1000).toFixed(1)}s` : "";
    const statusStr = sdkMsg.error_status ? ` [${sdkMsg.error_status}]` : "";
    return {
      id: nextBannerId(),
      kind: "retry",
      message: `Retrying API request${attemptStr}${delayStr}${statusStr}`,
      detail: sdkMsg.error ?? undefined,
      timestamp: now,
      ttl: (sdkMsg.retry_delay_ms ?? 5000) + 3000,
    };
  }

  // ── compact_boundary ──
  if (sdkMsg.type === "system" && sdkMsg.subtype === "compact_boundary") {
    const trigger = sdkMsg.compact_metadata?.trigger ?? "auto";
    const tokens = sdkMsg.compact_metadata?.pre_tokens;
    const tokenStr = tokens ? ` (${Math.round(tokens / 1000)}k tokens)` : "";
    return {
      id: nextBannerId(),
      kind: "compaction",
      message: `Context compacted (${trigger})${tokenStr}`,
      timestamp: now,
      ttl: 6000,
    };
  }

  // ── status: compacting ──
  if (sdkMsg.type === "system" && sdkMsg.subtype === "status" && sdkMsg.status === "compacting") {
    return {
      id: nextBannerId(),
      kind: "compaction",
      message: "Compacting conversation context...",
      timestamp: now,
      ttl: 15000,
    };
  }

  // ── hook events ──
  if (sdkMsg.type === "system" && sdkMsg.subtype === "hook_started") {
    return {
      id: nextBannerId(),
      kind: "warning",
      message: `Hook running: ${sdkMsg.hook_name ?? sdkMsg.hook_event ?? "unknown"}`,
      timestamp: now,
      ttl: 10000,
    };
  }
  if (sdkMsg.type === "system" && sdkMsg.subtype === "hook_response") {
    if (sdkMsg.outcome === "error") {
      return {
        id: nextBannerId(),
        kind: "warning",
        message: `Hook failed: ${sdkMsg.hook_name ?? "unknown"} (exit ${sdkMsg.exit_code ?? "?"})`,
        detail: sdkMsg.output || sdkMsg.stderr || undefined,
        timestamp: now,
        ttl: 8000,
      };
    }
    return null;
  }

  // ── auth_status ──
  if (sdkMsg.type === "auth_status" && sdkMsg.isAuthenticating) {
    return {
      id: nextBannerId(),
      kind: "warning",
      message: "Authenticating...",
      detail: sdkMsg.error ?? undefined,
      timestamp: now,
      ttl: 20000,
    };
  }

  // ── result errors ──
  if (sdkMsg.type === "result" && sdkMsg.is_error) {
    const errText = sdkMsg.errors?.join("; ") ?? sdkMsg.result ?? "Unknown error";
    return {
      id: nextBannerId(),
      kind: "warning",
      message: `Turn ended with error: ${sdkMsg.subtype ?? "unknown"}`,
      detail: errText,
      timestamp: now,
      ttl: 12000,
    };
  }

  return null;
}

// ── Hook: manage banner state ───────────────────────────

export function useStatusBanners() {
  const [banners, setBanners] = useState<StatusBannerItem[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  const addBanner = useCallback((banner: StatusBannerItem) => {
    setBanners((prev) => {
      // Deduplicate: if same kind already showing, replace it
      const filtered = prev.filter((b) => b.kind !== banner.kind);
      return [...filtered, banner];
    });

    // Auto-dismiss
    if (banner.ttl > 0) {
      // Clear previous timer for this kind
      const existing = timersRef.current.get(banner.kind);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        setBanners((prev) => prev.filter((b) => b.id !== banner.id));
        timersRef.current.delete(banner.kind);
      }, banner.ttl);
      timersRef.current.set(banner.kind, timer);
    }
  }, []);

  const dismissBanner = useCallback((id: string) => {
    setBanners((prev) => {
      const banner = prev.find((b) => b.id === id);
      if (banner) {
        const timer = timersRef.current.get(banner.kind);
        if (timer) {
          clearTimeout(timer);
          timersRef.current.delete(banner.kind);
        }
      }
      return prev.filter((b) => b.id !== id);
    });
  }, []);

  const processSdkEvent = useCallback(
    (sdkMsg: SdkMessage) => {
      const banner = classifySdkEvent(sdkMsg);
      if (banner) addBanner(banner);
    },
    [addBanner],
  );

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) {
        clearTimeout(timer);
      }
    };
  }, []);

  return { banners, processSdkEvent, dismissBanner };
}

// ── StatusBanner component ──────────────────────────────

function ProgressBar({ ttl, timestamp }: { ttl: number; timestamp: number }) {
  const [progress, setProgress] = useState(100);

  useEffect(() => {
    if (ttl <= 0) return;
    const interval = setInterval(() => {
      const elapsed = Date.now() - timestamp;
      const remaining = Math.max(0, 100 - (elapsed / ttl) * 100);
      setProgress(remaining);
      if (remaining <= 0) clearInterval(interval);
    }, 50);
    return () => clearInterval(interval);
  }, [ttl, timestamp]);

  if (ttl <= 0) return null;

  return (
    <div
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        height: 2,
        background: "var(--state-hover)",
        overflow: "hidden",
        borderRadius: "0 0 4px 4px",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${progress}%`,
          background: "currentColor",
          opacity: 0.3,
          transition: "width 0.1s linear",
        }}
      />
    </div>
  );
}

export function StatusBannerStack({
  banners,
  onDismiss,
}: {
  banners: StatusBannerItem[];
  onDismiss: (id: string) => void;
}) {
  if (banners.length === 0) return null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        flexShrink: 0,
      }}
    >
      {banners.map((banner) => {
        const config = BANNER_CONFIG[banner.kind];
        return (
          <div
            key={banner.id}
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 10px",
              background: config.bg,
              borderBottom: `1px solid ${config.border}`,
              color: config.color,
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              lineHeight: 1.4,
              overflow: "hidden",
              animation: "bannerSlideIn 0.2s ease-out",
            }}
          >
            <span
              style={{
                fontSize: 13,
                flexShrink: 0,
                width: 16,
                textAlign: "center",
              }}
            >
              {config.icon}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{banner.message}</div>
              {banner.detail && (
                <div
                  style={{
                    fontSize: 10,
                    opacity: 0.7,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    marginTop: 1,
                  }}
                >
                  {banner.detail}
                </div>
              )}
            </div>
            <button
              onClick={() => onDismiss(banner.id)}
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                background: "none",
                border: "none",
                color: config.color,
                opacity: 0.5,
                cursor: "pointer",
                fontSize: 14,
                padding: "0 2px",
                lineHeight: 1,
                flexShrink: 0,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.5")}
            >
              \u00D7
            </button>
            <ProgressBar ttl={banner.ttl} timestamp={banner.timestamp} />
          </div>
        );
      })}
    </div>
  );
}
