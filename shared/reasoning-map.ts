export type ReasoningNodeType =
  | "outcome"
  | "hypothesis"
  | "evidence"
  | "decision";

export type ReasoningNodeState =
  | "proposed"
  | "active"
  | "validated"
  | "refuted"
  | "parked"
  | "stale"
  | "closed";

export type EvidenceStrength = "none" | "weak" | "moderate" | "strong";
export type ClaimBasis = "observed" | "inferred" | "assumed" | "user_confirmed";
export type Confidence = "low" | "medium" | "high";

export type EvidenceSource =
  | "test_result"
  | "code_reference"
  | "user_statement"
  | "external_citation"
  | "runtime_observation"
  | "design_artifact"
  | "agent_assumption";

export interface EvidencePayload {
  source: EvidenceSource;
  strength: EvidenceStrength;
  summary: string;
  handle?: string;
}

export interface ReasoningNodeBase {
  id: string;
  type: ReasoningNodeType;
  title: string;
  summary: string;
  state: ReasoningNodeState;
  basis: ClaimBasis;
  confidence: Confidence;
  createdAt: string;
  updatedAt: string;
  supersedes?: string;
  risk?: {
    severity: "low" | "medium" | "high" | "critical";
    summary: string;
    resolved: boolean;
  };
  question?: {
    prompt: string;
    resolved: boolean;
  };
}

export interface OutcomeNode extends ReasoningNodeBase {
  type: "outcome";
  successSignal: string;
}

export interface HypothesisNode extends ReasoningNodeBase {
  type: "hypothesis";
  falsifiedBy: string;
}

export interface EvidenceNode extends ReasoningNodeBase {
  type: "evidence";
  evidence: EvidencePayload;
}

export interface DecisionNode extends ReasoningNodeBase {
  type: "decision";
  rationale: string;
  alternatives?: Array<{ title: string; reasonRejected: string }>;
  reversible: boolean;
}

export type ReasoningNode =
  | OutcomeNode
  | HypothesisNode
  | EvidenceNode
  | DecisionNode;

export type ReasoningEdgeKind =
  | "supports"
  | "depends_on"
  | "branches_to"
  | "maps_to";

export interface ReasoningEdge {
  id: string;
  sourceId: string;
  targetId: string;
  kind: ReasoningEdgeKind;
  polarity?: 1 | -1;
  strength?: "weak" | "moderate" | "strong";
  createdAt: string;
}

export type ActionBinding =
  | { kind: "minion_task"; taskId: string; nodeId?: string }
  | { kind: "tool_call"; name: string; callId?: string; nodeId?: string }
  | { kind: "manual"; nodeId?: string };

export type ChallengeClassification =
  | "misunderstanding"
  | "missing_evidence"
  | "conflicting_evidence"
  | "changed_requirement"
  | "bad_assumption";

export interface ReasoningChallenge {
  id: string;
  nodeId: string;
  userText: string;
  classification?: ChallengeClassification;
  status: "open" | "resolved";
  resolution?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface ReasoningRevision {
  id: string;
  at: string;
  summary: string;
  nodeId?: string;
  challengeId?: string;
}

export interface ReasoningMap {
  id: string;
  title: string;
  status: "active" | "closed";
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  finalSummary?: string;
  nodes: ReasoningNode[];
  edges: ReasoningEdge[];
  actionBindings: ActionBinding[];
  challenges: ReasoningChallenge[];
  revisions: ReasoningRevision[];
}

export interface ReasoningMapState {
  activeMapId?: string;
  maps: ReasoningMap[];
}

export type ReasoningNodeSeed =
  | Omit<OutcomeNode, "createdAt" | "updatedAt">
  | Omit<HypothesisNode, "createdAt" | "updatedAt">
  | Omit<EvidenceNode, "createdAt" | "updatedAt">
  | Omit<DecisionNode, "createdAt" | "updatedAt">;

export type ReasoningOp =
  | { op: "add_node"; node: ReasoningNodeSeed }
  | { op: "update_node"; nodeId: string; patch: Partial<ReasoningNodeBase> }
  | { op: "revise_node"; nodeId: string; node: ReasoningNodeSeed }
  | { op: "add_edge"; edge: Omit<ReasoningEdge, "createdAt"> }
  | { op: "remove_edge"; edgeId: string }
  | { op: "bind_action"; binding: ActionBinding }
  | {
      op: "resolve_challenge";
      challengeId: string;
      classification: ChallengeClassification;
      resolution: string;
    };

export interface ReasoningApplyResult {
  map: ReasoningMap;
  applied: number;
  validation: ValidationReport;
}

export interface ValidationFinding {
  severity: "error" | "warning";
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface ValidationReport {
  ok: boolean;
  findings: ValidationFinding[];
  generatedAt: string;
}

export interface ReasoningSummary {
  mapId: string;
  title: string;
  status: "active" | "closed";
  currentPath: string[];
  decisions: string[];
  unresolvedRisks: string[];
  openChallenges: string[];
  evidenceHandles: string[];
  summary: string;
}

interface ApplyOptions {
  now?: string;
}

const RISKY_HANDLE_SOURCES = new Set<EvidenceSource>([
  "test_result",
  "code_reference",
  "runtime_observation",
]);

const OPEN_STATES = new Set<ReasoningNodeState>(["proposed", "active", "validated"]);

export function createReasoningMap(input: {
  id: string;
  title: string;
  outcome: Omit<OutcomeNode, "id" | "type" | "state" | "createdAt" | "updatedAt"> & {
    id?: string;
    state?: ReasoningNodeState;
  };
  now?: string;
}): ReasoningMap {
  const now = input.now ?? new Date().toISOString();
  const outcome: OutcomeNode = {
    id: input.outcome.id ?? `${input.id}-outcome`,
    type: "outcome",
    title: input.outcome.title,
    summary: input.outcome.summary,
    successSignal: input.outcome.successSignal,
    state: input.outcome.state ?? "active",
    basis: input.outcome.basis,
    confidence: input.outcome.confidence,
    createdAt: now,
    updatedAt: now,
    ...(input.outcome.risk ? { risk: input.outcome.risk } : {}),
    ...(input.outcome.question ? { question: input.outcome.question } : {}),
    ...(input.outcome.supersedes ? { supersedes: input.outcome.supersedes } : {}),
  };
  return {
    id: input.id,
    title: input.title,
    status: "active",
    createdAt: now,
    updatedAt: now,
    nodes: [outcome],
    edges: [],
    actionBindings: [],
    challenges: [],
    revisions: [{ id: `${input.id}-rev-1`, at: now, summary: "Created reasoning map" }],
  };
}

export function applyReasoningOps(
  map: ReasoningMap,
  ops: ReasoningOp[],
  options: ApplyOptions = {},
): ReasoningApplyResult {
  const now = options.now ?? new Date().toISOString();
  let next: ReasoningMap = cloneMap(map);
  for (const op of ops) {
    next = applyReasoningOp(next, op, now);
  }
  next.updatedAt = now;
  return {
    map: next,
    applied: ops.length,
    validation: validateReasoningMap(next, now),
  };
}

export function validateReasoningMap(
  map: ReasoningMap,
  now = new Date().toISOString(),
): ValidationReport {
  const findings: ValidationFinding[] = [];
  const nodes = new Map(map.nodes.map((node) => [node.id, node]));
  const activeNodes = map.nodes.filter((node) => OPEN_STATES.has(node.state));

  for (const node of map.nodes) {
    if (node.type === "hypothesis" && !node.falsifiedBy?.trim()) {
      findings.push(error("hypothesis_missing_falsified_by", "Hypothesis requires falsifiedBy.", node.id));
    }
    if (node.type === "hypothesis" && evidenceFor(map, node.id).length === 0) {
      findings.push(warn("hypothesis_without_evidence", "Hypothesis has no supporting or refuting evidence.", node.id));
    }
    if (node.type !== "evidence" && node.confidence === "high" && strongestEvidence(map, node.id) < strengthRank("moderate")) {
      findings.push(warn("high_confidence_weak_evidence", "High confidence claim has weak or missing evidence.", node.id));
    }
    if (node.type === "evidence") {
      const missingHandle = RISKY_HANDLE_SOURCES.has(node.evidence.source) && !node.evidence.handle;
      if (missingHandle) {
        findings.push(warn("evidence_missing_handle", "Test, code, and runtime evidence should include a retrievable handle.", node.id));
      }
      if (node.supersedes && node.state !== "stale") {
        findings.push(warn("evidence_stale", "Evidence supersedes earlier material context but is not marked stale.", node.id));
      }
    }
    if (node.type === "decision") {
      const support = evidenceFor(map, node.id).map((e) => nodes.get(e.sourceId)).filter(Boolean) as ReasoningNode[];
      const onlyAssumptions = support.length === 0
        ? node.basis === "assumed"
        : support.every((supportNode) =>
            supportNode.basis === "assumed" ||
            (supportNode.type === "evidence" && supportNode.evidence.source === "agent_assumption"),
          );
      if (onlyAssumptions) {
        findings.push(warn("decision_only_assumptions", "Decision is based only on assumptions.", node.id));
      }
      const criticalRisk = activeNodes.find((n) => n.risk?.severity === "critical" && !n.risk.resolved);
      if (criticalRisk) {
        findings.push(warn("decision_with_critical_risk", `Decision made while critical risk is unresolved: ${criticalRisk.title}.`, node.id));
      }
    }
  }

  for (const target of activeNodes) {
    const incoming = evidenceFor(map, target.id);
    const hasSupport = incoming.some((edge) => (edge.polarity ?? 1) === 1);
    const hasRefute = incoming.some((edge) => edge.polarity === -1);
    if (hasSupport && hasRefute) {
      findings.push(error("contradictory_evidence", "Node has unresolved supporting and refuting evidence.", target.id));
    }
  }

  for (const edge of map.edges) {
    if (!nodes.has(edge.sourceId) || !nodes.has(edge.targetId)) {
      findings.push(error("edge_missing_node", "Edge references a missing node.", undefined, edge.id));
    }
  }

  for (const node of activeNodes) {
    const branches = map.edges.filter((edge) => edge.kind === "branches_to" && edge.sourceId === node.id);
    if (branches.length > 3) {
      findings.push(warn("too_many_open_branches", "Too many open branches without consolidation.", node.id));
    }
  }

  for (const nodeId of unresolvedDependencyCycle(map)) {
    findings.push(error("circular_unresolved_dependency", "Circular unresolved dependency detected.", nodeId));
  }

  return {
    ok: !findings.some((finding) => finding.severity === "error"),
    findings,
    generatedAt: now,
  };
}

export function summarizeReasoningMap(map: ReasoningMap, budget = 1200): ReasoningSummary {
  const currentPath = map.nodes
    .filter((node) => node.state === "active" || node.state === "validated")
    .map((node) => `${node.type}: ${node.title}`);
  const decisions = map.nodes
    .filter((node): node is DecisionNode => node.type === "decision")
    .filter((node) => node.state !== "stale" && node.state !== "refuted")
    .map((node) => `${node.title}: ${node.rationale}`);
  const unresolvedRisks = map.nodes
    .filter((node) => node.risk && !node.risk.resolved)
    .map((node) => `${node.title}: ${node.risk!.summary}`);
  const openChallenges = map.challenges
    .filter((challenge) => challenge.status === "open")
    .map((challenge) => `${challenge.nodeId}: ${challenge.userText}`);
  const evidenceHandles = map.nodes
    .filter((node): node is EvidenceNode => node.type === "evidence")
    .map((node) => node.evidence.handle)
    .filter((handle): handle is string => Boolean(handle));
  const parts = [
    `Reasoning Graph "${map.title}" is ${map.status}.`,
    currentPath.length ? `Current path: ${currentPath.join("; ")}.` : "",
    decisions.length ? `Decisions: ${decisions.join("; ")}.` : "",
    unresolvedRisks.length ? `Unresolved risks: ${unresolvedRisks.join("; ")}.` : "",
    openChallenges.length ? `Open challenges: ${openChallenges.join("; ")}.` : "",
  ].filter(Boolean);
  return {
    mapId: map.id,
    title: map.title,
    status: map.status,
    currentPath,
    decisions,
    unresolvedRisks,
    openChallenges,
    evidenceHandles,
    summary: truncate(parts.join(" "), budget),
  };
}

export function recordReasoningChallenge(
  map: ReasoningMap,
  input: {
    id: string;
    nodeId: string;
    userText: string;
    classification?: ChallengeClassification;
    resolution?: string;
    now?: string;
  },
): ReasoningMap {
  if (!map.nodes.some((node) => node.id === input.nodeId)) {
    throw new Error(`Cannot challenge missing node: ${input.nodeId}`);
  }
  const now = input.now ?? new Date().toISOString();
  const status = input.resolution ? "resolved" : "open";
  return {
    ...cloneMap(map),
    updatedAt: now,
    challenges: [
      ...map.challenges,
      stripUndefined({
        id: input.id,
        nodeId: input.nodeId,
        userText: input.userText,
        classification: input.classification,
        status,
        resolution: input.resolution,
        createdAt: now,
        resolvedAt: status === "resolved" ? now : undefined,
      }) as ReasoningChallenge,
    ],
    revisions: [
      ...map.revisions,
      {
        id: `${input.id}-rev`,
        at: now,
        nodeId: input.nodeId,
        challengeId: input.id,
        summary: `Challenge recorded: ${input.userText}`,
      },
    ],
  };
}

export function closeReasoningMap(map: ReasoningMap, finalSummary: string, now = new Date().toISOString()): ReasoningMap {
  return {
    ...cloneMap(map),
    status: "closed",
    closedAt: now,
    updatedAt: now,
    finalSummary,
    revisions: [
      ...map.revisions,
      { id: `rev-close-${map.revisions.length + 1}`, at: now, summary: "Closed reasoning map" },
    ],
  };
}

function applyReasoningOp(
  map: ReasoningMap,
  op: ReasoningOp,
  now: string,
): ReasoningMap {
  switch (op.op) {
    case "add_node": {
      if (map.nodes.some((node) => node.id === op.node.id)) {
        throw new Error(`Node already exists: ${op.node.id}`);
      }
      const node = materializeNode(op.node, now);
      return revise(map, now, `Added ${node.type}: ${node.title}`, node.id, { nodes: [...map.nodes, node] });
    }
    case "update_node": {
      const idx = map.nodes.findIndex((node) => node.id === op.nodeId);
      if (idx < 0) throw new Error(`Node not found: ${op.nodeId}`);
      const nodes = [...map.nodes];
      nodes[idx] = { ...nodes[idx]!, ...op.patch, id: op.nodeId, updatedAt: now } as ReasoningNode;
      return revise(map, now, `Updated node: ${nodes[idx]!.title}`, op.nodeId, { nodes });
    }
    case "revise_node": {
      const prior = map.nodes.find((node) => node.id === op.nodeId);
      if (!prior) throw new Error(`Node not found: ${op.nodeId}`);
      const node = materializeNode({ ...op.node, supersedes: op.nodeId }, now);
      const nodes = map.nodes.map((n) => n.id === op.nodeId ? { ...n, state: "stale" as const, updatedAt: now } : n);
      return revise(map, now, `Revised node: ${prior.title}`, node.id, { nodes: [...nodes, node] });
    }
    case "add_edge": {
      if (map.edges.some((edge) => edge.id === op.edge.id)) {
        throw new Error(`Edge already exists: ${op.edge.id}`);
      }
      const nodeIds = new Set(map.nodes.map((node) => node.id));
      if (!nodeIds.has(op.edge.sourceId) || !nodeIds.has(op.edge.targetId)) {
        throw new Error(`Edge references missing node: ${op.edge.id}`);
      }
      return revise(map, now, `Linked ${op.edge.sourceId} to ${op.edge.targetId}`, undefined, {
        edges: [...map.edges, { ...op.edge, createdAt: now }],
      });
    }
    case "remove_edge":
      return revise(map, now, `Removed edge: ${op.edgeId}`, undefined, {
        edges: map.edges.filter((edge) => edge.id !== op.edgeId),
      });
    case "bind_action":
      return revise(map, now, `Bound action: ${op.binding.kind}`, op.binding.nodeId, {
        actionBindings: [...map.actionBindings, op.binding],
      });
    case "resolve_challenge": {
      const challenges = map.challenges.map((challenge) =>
        challenge.id === op.challengeId
          ? {
              ...challenge,
              classification: op.classification,
              resolution: op.resolution,
              status: "resolved" as const,
              resolvedAt: now,
            }
          : challenge,
      );
      return revise(map, now, `Resolved challenge: ${op.challengeId}`, undefined, { challenges });
    }
  }
  throw new Error(`Unsupported reasoning op: ${String((op as { op?: unknown }).op)}`);
}

function materializeNode(seed: ReasoningNodeSeed, now: string): ReasoningNode {
  return { ...seed, createdAt: now, updatedAt: now } as ReasoningNode;
}

function revise(
  map: ReasoningMap,
  now: string,
  summary: string,
  nodeId: string | undefined,
  patch: Partial<Pick<ReasoningMap, "nodes" | "edges" | "actionBindings" | "challenges">>,
): ReasoningMap {
  return {
    ...cloneMap(map),
    ...patch,
    revisions: [
      ...map.revisions,
      stripUndefined({
        id: `rev-${map.revisions.length + 1}`,
        at: now,
        summary,
        nodeId,
      }) as ReasoningRevision,
    ],
  };
}

function evidenceFor(map: ReasoningMap, nodeId: string): ReasoningEdge[] {
  const evidenceIds = new Set(map.nodes.filter((node) => node.type === "evidence").map((node) => node.id));
  return map.edges.filter((edge) => edge.kind === "supports" && edge.targetId === nodeId && evidenceIds.has(edge.sourceId));
}

function strongestEvidence(map: ReasoningMap, nodeId: string): number {
  const nodes = new Map(map.nodes.map((node) => [node.id, node]));
  return evidenceFor(map, nodeId).reduce((best, edge) => {
    if (edge.polarity === -1) return best;
    const node = nodes.get(edge.sourceId);
    if (node?.type !== "evidence") return best;
    return Math.max(best, strengthRank(node.evidence.strength));
  }, 0);
}

function strengthRank(strength: EvidenceStrength): number {
  return ({ none: 0, weak: 1, moderate: 2, strong: 3 })[strength];
}

function unresolvedDependencyCycle(map: ReasoningMap): string[] {
  const openIds = new Set(map.nodes.filter((node) => OPEN_STATES.has(node.state)).map((node) => node.id));
  const graph = new Map<string, string[]>();
  for (const edge of map.edges) {
    if (edge.kind !== "depends_on" || !openIds.has(edge.sourceId) || !openIds.has(edge.targetId)) continue;
    graph.set(edge.sourceId, [...(graph.get(edge.sourceId) ?? []), edge.targetId]);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cyclic = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) {
      cyclic.add(id);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of graph.get(id) ?? []) visit(next);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of graph.keys()) visit(id);
  return Array.from(cyclic);
}

function error(code: string, message: string, nodeId?: string, edgeId?: string): ValidationFinding {
  return stripUndefined({
    severity: "error",
    code,
    message,
    nodeId,
    edgeId,
  }) as ValidationFinding;
}

function warn(code: string, message: string, nodeId?: string): ValidationFinding {
  return stripUndefined({
    severity: "warning",
    code,
    message,
    nodeId,
  }) as ValidationFinding;
}

function cloneMap(map: ReasoningMap): ReasoningMap {
  return {
    ...map,
    nodes: map.nodes.map((node) => ({ ...node })),
    edges: map.edges.map((edge) => ({ ...edge })),
    actionBindings: map.actionBindings.map((binding) => ({ ...binding })),
    challenges: map.challenges.map((challenge) => ({ ...challenge })),
    revisions: map.revisions.map((revision) => ({ ...revision })),
  };
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 16))} [truncated]`;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
