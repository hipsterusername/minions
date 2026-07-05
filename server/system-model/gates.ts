import { openProjectDb, readSettings } from "../project-store.ts";
import type { SessionHost } from "../session-host.ts";
import { getDetailedDiff } from "../worktree.ts";
import { hasSystemModelManifest, loadSystemModel } from "./load.ts";
import type { SystemModelMode } from "./runtime.ts";
import { globMatches } from "./match.ts";
import {
  reconciliationReportSchema,
  workPacketSchema,
  type WorkPacket,
} from "../../shared/system-model/index.ts";

export interface MergeGateVerdict {
  allowed: boolean;
  mode: SystemModelMode;
  gates: Array<{
    id: string;
    name: string;
    status: "not_required" | "required_pending" | "passed" | "failed" | "waived";
    reason: string;
  }>;
}

type GateStatus = MergeGateVerdict["gates"][number]["status"];

interface StoredPacket {
  packet: WorkPacket;
  reconciled: boolean;
  reconciledGateStatus: Map<string, { status: GateStatus; reason: string }>;
  verificationResults: string[];
}

export async function evaluateMergeGates(host: SessionHost): Promise<MergeGateVerdict> {
  const worktree = host.worktree;
  const projectPath = worktree?.projectPath ?? host.cwd;
  const mode = normalizeMode(readSettings(projectPath).systemModel);
  if (mode === "off" || !worktree) return { allowed: true, mode: "off", gates: [] };
  if (!hasSystemModelManifest(host.cwd)) return { allowed: true, mode: "off", gates: [] };

  const { model } = loadSystemModel(host.cwd);
  if (!model) return { allowed: true, mode, gates: [] };

  const diff = await getDetailedDiff(worktree);
  const changedFiles = diff.files.map((file) => file.file);
  const packet = readLatestSessionPacket(projectPath, host.id);

  const gates = model.policies.reviewGates.map((gate) => {
    const hit = changedFiles.find((file) =>
      gate.requiredWhen.files.some((glob) => globMatches(glob, file)),
    );
    if (!hit) {
      return {
        id: gate.id,
        name: gate.name,
        status: "not_required" as const,
        reason: "No changed files match this gate.",
      };
    }

    if (!packet) {
      return {
        id: gate.id,
        name: gate.name,
        status: "required_pending" as const,
        reason: `Required because ${hit} changed, but no work packet exists.`,
      };
    }

    const packetGate = packet.packet.reviewGates.find((item) => item.gateId === gate.id);
    if (packetGate?.status === "waived" || packet.packet.status === "waived") {
      return {
        id: gate.id,
        name: gate.name,
        status: "waived" as const,
        reason: packetGate?.reason || "Gate waived on the work packet.",
      };
    }

    const reconciled = packet.reconciledGateStatus.get(gate.id);
    if (reconciled?.status === "waived" || reconciled?.status === "failed" || reconciled?.status === "passed") {
      return { id: gate.id, name: gate.name, status: reconciled.status, reason: reconciled.reason };
    }

    if (!packet.reconciled) {
      return {
        id: gate.id,
        name: gate.name,
        status: "required_pending" as const,
        reason: `Required because ${hit} changed; reconciliation has not run.`,
      };
    }

    if (packet.verificationResults.includes("failed")) {
      return {
        id: gate.id,
        name: gate.name,
        status: "failed" as const,
        reason: `Required because ${hit} changed; at least one verification failed.`,
      };
    }

    if (packet.verificationResults.length > 0 && packet.verificationResults.every((result) => result === "passed")) {
      return {
        id: gate.id,
        name: gate.name,
        status: "passed" as const,
        reason: `Required because ${hit} changed; reconciliation and verifications passed.`,
      };
    }

    return {
      id: gate.id,
      name: gate.name,
      status: "required_pending" as const,
      reason: `Required because ${hit} changed; verification is incomplete.`,
    };
  });

  return {
    allowed: !gates.some((gate) => gate.status === "required_pending" || gate.status === "failed"),
    mode,
    gates,
  };
}

export function shouldWarnForMergeGates(verdict: MergeGateVerdict): boolean {
  return verdict.mode === "advisory" && !verdict.allowed;
}

export function shouldEvaluateMergeGates(host: SessionHost): boolean {
  const worktree = host.worktree;
  if (!worktree) return false;
  const mode = normalizeMode(readSettings(worktree.projectPath).systemModel);
  return mode !== "off" && hasSystemModelManifest(host.cwd);
}

function readLatestSessionPacket(projectPath: string, sessionKey: string): StoredPacket | null {
  const db = openProjectDb(projectPath);
  const row = db.prepare(
    `SELECT id, packet_json
     FROM work_packets
     WHERE leader_session_key = ?
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`,
  ).get(sessionKey) as { id: string; packet_json: string } | undefined;
  if (!row) return null;

  const packet = workPacketSchema.parse(JSON.parse(row.packet_json));
  const report = db.prepare(
    `SELECT report_json
     FROM reconciliation_reports
     WHERE work_packet_id = ?
     ORDER BY created_at DESC
     LIMIT 1`,
  ).get(row.id) as { report_json: string } | undefined;
  const reconciledGateStatus = new Map<string, { status: GateStatus; reason: string }>();
  if (report) {
    const parsed = reconciliationReportSchema.parse(JSON.parse(report.report_json));
    for (const gate of parsed.gates) {
      reconciledGateStatus.set(gate.gateId, { status: gate.status, reason: gate.reason });
    }
  }

  const verifications = db.prepare(
    `SELECT result FROM work_packet_verifications WHERE work_packet_id = ? ORDER BY kind, target`,
  ).all(row.id) as Array<{ result: string }>;

  return {
    packet,
    reconciled: Boolean(report),
    reconciledGateStatus,
    verificationResults: verifications.map((item) => item.result),
  };
}

function normalizeMode(value: unknown): SystemModelMode {
  return value === "advisory" || value === "enforced" ? value : "off";
}
