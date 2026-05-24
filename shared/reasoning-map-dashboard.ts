import type {
  RenderComponent,
  TimelineComponent,
} from "./render-dsl.ts";
import {
  summarizeReasoningMap,
  type DecisionNode,
  type EvidenceNode,
  type ReasoningMap,
  type ValidationReport,
} from "./reasoning-map.ts";

export const REASONING_MAP_DASHBOARD_COMPONENT_ID = "reasoning-map-dashboard";

export function buildReasoningMapDashboardSection(
  map: ReasoningMap,
  validation: ValidationReport,
): RenderComponent {
  return {
    id: REASONING_MAP_DASHBOARD_COMPONENT_ID,
    type: "section",
    title: "Reasoning Graph",
    badge: validation.ok ? map.status : "needs review",
    defaultOpen: true,
    components: buildReasoningMapDashboard(map, validation),
    span: "full",
  };
}

export function buildReasoningMapDashboard(
  map: ReasoningMap,
  validation: ValidationReport,
): RenderComponent[] {
  const summary = summarizeReasoningMap(map);
  const active = map.nodes.filter((node) => node.state === "active" || node.state === "validated");
  const risks = map.nodes.filter((node) => node.risk && !node.risk.resolved);
  const decisions = map.nodes.filter((node): node is DecisionNode => node.type === "decision");
  const evidence = map.nodes.filter((node): node is EvidenceNode => node.type === "evidence");
  const findings = validation.findings;

  return [
    {
      id: "reasoning-map-status",
      type: "status",
      label: validation.ok ? "Reasoning Graph" : "Validation",
      state: validation.ok ? "success" : "warning",
    },
    {
      id: "reasoning-map-metrics",
      type: "kv",
      title: map.title,
      entries: [
        { key: "Map", value: map.id },
        { key: "Status", value: map.status },
        { key: "Nodes", value: String(map.nodes.length) },
        { key: "Findings", value: String(findings.length), color: findings.length ? "yellow" : "green" },
      ],
    },
    {
      id: "reasoning-map-tabs",
      type: "tabs",
      activeTabId: "current-path",
      tabs: [
        {
          id: "current-path",
          label: "Current Path",
          components: [
            {
              id: "reasoning-current-path",
              type: "checklist",
              title: "Active Reasoning",
              items: active.length
                ? active.map((node) => ({
                    label: `${node.type}: ${node.title} (${node.basis}, ${node.confidence})`,
                    checked: node.state === "validated",
                  }))
                : [{ label: "No active path", checked: false }],
            },
            {
              id: "reasoning-current-summary",
              type: "text",
              content: summary.summary,
              span: "full",
            },
          ],
        },
        {
          id: "risks",
          label: "Unresolved Risk",
          badge: risks.length ? String(risks.length) : undefined,
          components: [
            {
              id: "reasoning-risks",
              type: "table",
              headers: ["Node", "Severity", "Risk"],
              rows: risks.map((node) => [
                node.title,
                node.risk!.severity,
                node.risk!.summary,
              ]),
              span: "full",
            },
            {
              id: "reasoning-questions",
              type: "list",
              title: "Open Questions",
              items: map.nodes
                .filter((node) => node.question && !node.question.resolved)
                .map((node) => `${node.title}: ${node.question!.prompt}`),
              span: "full",
            },
          ],
        },
        {
          id: "decisions",
          label: "Decisions",
          badge: decisions.length ? String(decisions.length) : undefined,
          components: [
            {
              id: "reasoning-decisions",
              type: "table",
              headers: ["Decision", "Confidence", "Basis", "Rationale"],
              rows: decisions.map((node) => [
                node.title,
                node.confidence,
                node.basis,
                node.rationale,
              ]),
              span: "full",
            },
            {
              id: "reasoning-evidence",
              type: "table",
              headers: ["Evidence", "Source", "Strength", "Handle"],
              rows: evidence.map((node) => [
                node.title,
                node.evidence.source,
                node.evidence.strength,
                node.evidence.handle ?? "",
              ]),
              span: "full",
            },
          ],
        },
        {
          id: "audit",
          label: "Audit",
          badge: findings.length ? String(findings.length) : undefined,
          components: [
            {
              id: "reasoning-validation",
              type: "table",
              headers: ["Severity", "Code", "Node", "Message"],
              rows: findings.map((finding) => [
                finding.severity,
                finding.code,
                finding.nodeId ?? finding.edgeId ?? "",
                finding.message,
              ]),
              span: "full",
            },
            {
              id: "reasoning-challenges",
              type: "table",
              headers: ["Status", "Node", "Classification", "Challenge"],
              rows: map.challenges.map((challenge) => [
                challenge.status,
                challenge.nodeId,
                challenge.classification ?? "",
                challenge.userText,
              ]),
              span: "full",
            },
            {
              id: "reasoning-challenge-form",
              type: "form",
              title: "Challenge Node",
              fields: [
                {
                  id: "nodeId",
                  kind: "select",
                  label: "Node",
                  required: true,
                  options: map.nodes.map((node) => ({
                    value: node.id,
                    label: `${node.type}: ${node.title}`,
                  })),
                },
                {
                  id: "userText",
                  kind: "textarea",
                  label: "Challenge",
                  required: true,
                },
              ],
              submitLabel: "Challenge",
              span: "full",
            },
          ],
        },
        {
          id: "timeline",
          label: "Timeline",
          components: [buildTimeline(map)],
        },
      ],
      span: "full",
    },
  ];
}

function buildTimeline(map: ReasoningMap): TimelineComponent {
  const revisionEvents = map.revisions.map((revision) => ({
    label: revision.summary,
    detail: [revision.nodeId, revision.challengeId].filter(Boolean).join(" "),
    state: "success" as const,
    time: revision.at,
  }));
  const challengeEvents = map.challenges.map((challenge) => ({
    label: `Challenge ${challenge.status}`,
    detail: challenge.resolution ?? challenge.userText,
    state: challenge.status === "resolved" ? "success" as const : "warning" as const,
    time: challenge.resolvedAt ?? challenge.createdAt,
  }));
  return {
    id: "reasoning-timeline",
    type: "timeline",
    title: "Reasoning Updates",
    events: [...revisionEvents, ...challengeEvents].sort((a, b) =>
      (a.time ?? "").localeCompare(b.time ?? ""),
    ),
    span: "full",
  };
}
