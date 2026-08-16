import { TaskGraphValidationError } from "./errors.ts";

export const MAX_PLANNING_SOURCE_BYTES = 256 * 1024;
export const MAX_PLANNING_NODE_CONTEXT_BYTES = 512 * 1024;
export const MAX_PLANNING_SNAPSHOT_CONTEXT_BYTES = 2 * 1024 * 1024;

interface ContextSource {
  sourceSnapshotId: string;
  nodeId: string;
  sourceId: string;
  contentHash: string;
  content: string;
}

export function assertPlanningContextLimits(sources: readonly ContextSource[]): void {
  const byNode = new Map<string, number>();
  const unique = new Map<string, number>();
  for (const source of sources) {
    const bytes = Buffer.byteLength(source.content);
    if (bytes > MAX_PLANNING_SOURCE_BYTES) {
      throw new TaskGraphValidationError(
        `Planning context source ${source.sourceId} exceeds the 256 KiB limit`,
      );
    }
    const nodeBytes = (byNode.get(source.nodeId) ?? 0) + bytes;
    if (nodeBytes > MAX_PLANNING_NODE_CONTEXT_BYTES) {
      throw new TaskGraphValidationError(
        `Task ${source.nodeId} exceeds the 512 KiB planning-context limit`,
      );
    }
    byNode.set(source.nodeId, nodeBytes);
    unique.set(`${source.sourceSnapshotId}:${source.sourceId}:${source.contentHash}`, bytes);
  }
  const snapshotBytes = [...unique.values()].reduce((sum, bytes) => sum + bytes, 0);
  if (snapshotBytes > MAX_PLANNING_SNAPSHOT_CONTEXT_BYTES) {
    throw new TaskGraphValidationError("Frozen planning context exceeds the 2 MiB snapshot limit");
  }
}
