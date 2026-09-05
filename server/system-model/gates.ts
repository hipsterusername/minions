import { openProjectDb, readSettings } from "../project-store.ts";
import type { SessionHost } from "../session-host.ts";
import { getDetailedDiff } from "../worktree.ts";
import { loadSystemModel } from "./load.ts";
import type { SystemModelMode } from "./runtime.ts";
import { workPacketSchema } from "../../shared/system-model/index.ts";
import { getLatestReconciliationReportForPacket, listWorkPacketVerifications } from "./store.ts";
import { captureEvidenceBinding, evidenceHash } from "./evidence-binding.ts";
import { reviewGateMatches } from "./review-gates.ts";
import { globMatches } from "./match.ts";

export interface MergeGateVerdict {
  allowed: boolean;
  policyDigest?: string;
  mode: SystemModelMode;
  gates: Array<{
    id: string;
    name: string;
    status: "not_required" | "required_pending" | "passed" | "failed" | "waived";
    reason: string;
  }>;
}


export async function evaluateMergeGates(host: SessionHost): Promise<MergeGateVerdict> {
  return evaluateMergeGatesForContext({ worktree: host.worktree, cwd: host.cwd, sessionKey: host.id });
}

export async function evaluateMergeGatesForContext(input: { worktree: SessionHost["worktree"];
  cwd: string; sessionKey: string }): Promise<MergeGateVerdict> {
  const projectPath = input.worktree?.projectPath ?? input.cwd;
  const mode = normalizeMode(readSettings(projectPath).systemModel);
  if (mode === "off" || !input.worktree) return { allowed: true, mode: "off", gates: [] };
  const { model } = loadSystemModel(input.cwd);
  if (!model) return { allowed: false, mode, gates: [{ id: "model_unavailable", name: "System model",
    status: "required_pending", reason: "System model could not be loaded." }] };
  const diff = await getDetailedDiff(input.worktree);
  const files = diff.files.map(file => file.file);
  const row = openProjectDb(projectPath).prepare(`SELECT packet_json FROM work_packets
    WHERE leader_session_key=? ORDER BY updated_at DESC, created_at DESC LIMIT 1`)
    .get(input.sessionKey) as { packet_json: string } | undefined;
  const packet = row ? workPacketSchema.parse(JSON.parse(row.packet_json)) : null;
  const report = packet ? getLatestReconciliationReportForPacket(projectPath, packet.id) : null;
  const rows = packet ? listWorkPacketVerifications(projectPath, packet.id) : [];
  const capabilities = model.capabilities.filter(c => files.some(file =>
    [...c.suggestedFiles, ...c.entryPoints.flatMap(e => e.files)].some(glob => globMatches(glob, file))));
  const flows = model.flows.filter(f => files.some(file => f.suggestedFiles.some(glob => globMatches(glob, file))));
  const levels = ["low", "medium", "high", "critical"] as const;
  const risk = levels[Math.max(levels.indexOf(packet?.riskLevel ?? "low"),
    ...[...capabilities, ...flows].map(c => levels.indexOf(c.risk))) ] ?? "low";
  const scope = { files, capabilities: [...(packet?.scope.capabilities ?? []), ...capabilities.map(c => c.id)],
    flows: [...(packet?.scope.flows ?? []), ...flows.map(f => f.id)], risk };
  let digest: string | null = null;
  if (packet && report) {
    try { digest = await captureEvidenceBinding(input.cwd, packet, model, projectPath); }
    catch { /* Unreadable state cannot reuse passing evidence. */ }
  }
  const gates: MergeGateVerdict["gates"] = model.policies.reviewGates.map(gate => {
    const verdict = (status: MergeGateVerdict["gates"][number]["status"], reason: string) =>
      ({ id: gate.id, name: gate.name, status, reason });
    if (!reviewGateMatches(gate, scope)) return verdict("not_required", "No diff or scope match.");
    if (!packet) return verdict("required_pending", "A Work Packet is required.");
    const waiver = packet.reviewGates.find(item => item.gateId === gate.id);
    if (packet.status === "waived" || waiver?.status === "waived") {
      return verdict("waived", waiver?.reason || "Explicit Work Packet waiver.");
    }
    // The binding covers file bytes, modes, symlinks, baseline and policy. The
    // presentation diff also contains commit messages, which collection changes.
    if (!report || !digest || report.evidenceDigest !== digest) {
      return verdict("required_pending", "Reconcile the current repository changes and policy; stored evidence is missing or stale.");
    }
    const failure = report.gates.find(item => item.gateId === gate.id && item.status === "failed");
    if (failure) return verdict("failed", failure.reason);
    const unresolved = report.deterministic.constraintsInScope.filter(id =>
      !report.constraintVerdicts.some(v => v.constraintId === id && v.status === "appears_satisfied" && v.evidence.length > 0));
    if (unresolved.length || report.acceptanceCoverage.status !== "complete"
      || report.systemModelUpdate.status === "review_required"
      || packet.criterionCoverage?.some(c => !["supported", "verified", "waived"].includes(c.status))) {
      return verdict("required_pending", "Resolve constraint verdicts, acceptance coverage, and model review.");
    }
    const required = [...packet.freshness.requiredVerifications,
      ...(gate.requiredChecks?.length ? gate.requiredChecks : [{ kind: "manual_review", target: gate.id }])];
    const checks = required.map(check => rows.find(row => row.kind === check.kind && row.target === check.target
      && row.evidenceDigest === digest));
    if (checks.some(check => check?.result === "failed")) return verdict("failed", "A required check failed.");
    if (checks.some(check => check?.result !== "passed")) {
      return verdict("required_pending", `Record current passing checks: ${required.map(c => `${c.kind}:${c.target}`).join(", ")}`);
    }
    return verdict("passed", "Current reconciliation and all required checks passed.");
  });
  return { policyDigest: evidenceHash(model.policies), allowed: !gates.some(gate => model.policies.reviewGates.find(policy => policy.id === gate.id)?.blocksMerge
    && (gate.status === "required_pending" || gate.status === "failed")), mode, gates };
}

export function shouldWarnForMergeGates(verdict: MergeGateVerdict): boolean {
  return verdict.mode === "advisory" && !verdict.allowed;
}
export function shouldEvaluateMergeGates(host: SessionHost): boolean {
  return Boolean(host.worktree) && normalizeMode(readSettings(host.worktree!.projectPath).systemModel) !== "off";
}
function normalizeMode(value: unknown): SystemModelMode {
  return value === "enforced" || value === "advisory" ? value : "off";
}
