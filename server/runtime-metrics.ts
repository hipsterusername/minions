import { monitorEventLoopDelay } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import { serverLogger } from "./logging.ts";
import { historyCacheStats } from "./history-cache.ts";
import { outboundQueueStats } from "./transport-budget.ts";
import { artifactValidatorCacheStats } from "./task-graph/artifact-schema-cache.ts";

const log = serverLogger.child("runtime");

/** Fixed-size diagnostics: no snapshots, retained sample history or forced GC. */
export function startRuntimeMetrics(
  counts: () => { sessions: number; activeSessions: number },
  intervalMs = 60_000,
): () => void {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  const timer = setInterval(() => {
    try {
      const memory = process.memoryUsage();
      const heapLimitBytes = getHeapStatistics().heap_size_limit;
      const heapRatio = memory.heapUsed / heapLimitBytes;
      const outbound = outboundQueueStats();
      const fields = {
        sampledAt: new Date().toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
        heapUsedBytes: memory.heapUsed,
        heapLimitBytes,
        rssBytes: memory.rss,
        externalBytes: memory.external,
        arrayBufferBytes: memory.arrayBuffers,
        historyCache: historyCacheStats(),
        artifactValidators: artifactValidatorCacheStats(),
        outboundQueue: { bytes: outbound.bytes, entries: outbound.messages },
        eventLoopP95Ms: delay.count > 0 ? delay.percentile(95) / 1e6 : 0,
        eventLoopMaxMs: delay.count > 0 ? delay.max / 1e6 : 0,
        ...counts(),
      };
      if (heapRatio >= 0.75) log.warn("memory_pressure", fields);
      else log.info("resource_sample", fields);
    } catch {
      // Diagnostics must never turn a sampling failure into a server crash.
      log.warn("resource_sample_failed");
    } finally {
      delay.reset();
    }
  }, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    delay.disable();
  };
}
