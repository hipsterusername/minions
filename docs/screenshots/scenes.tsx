// Documentation fixtures: real product components, invented project/run data.
// This entry is loaded only by capture.mjs, never by the application.
import React, { createRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectList } from "../../src/ProjectList.tsx";
import { ActivityLaunchForm } from "../../src/nodes/leader/ActivityLaunchForm.tsx";
import { LEADER_DEFAULT_DATA } from "../../src/nodes/leader/types.ts";
import { TaskPlanPanel } from "../../src/nodes/leader/TaskPlanPanel.tsx";
import { MinionNodeRenderer, MINION_DEFAULT_DATA } from "../../src/nodes/MinionNode.tsx";
import { DashboardSurface } from "../../src/nodes/render/DashboardSurface.tsx";
import { GraphInspector } from "../../src/task-graph/GraphInspector.tsx";
import { createGraphFixture } from "../../src/task-graph/fixtures.ts";
import { HarnessListProvider } from "../../src/use-harness-list.tsx";
import { applyTheme } from "../../src/themes.ts";
import { renderComponentSchema } from "../../shared/render-dsl.ts";
import "../../src/index.css";
import "../../src/activity.css";
import "../../src/nodes/leader/leader-node.css";
import "../../src/theme-skins/index.css";
import "./style.css";

applyTheme("daybook");
const noop = () => {};
const titles = ["Inspect the starter", "Implement greeting", "Write usage notes", "Verify and summarize"];
const prompt = `Improve this tiny greeting project. Add an optional name argument and a friendly default.\n\nDelegate greet.mjs and USAGE.md to separate Minions with disjoint write scopes. After both finish, verify the behavior yourself.\n\nShow progress on a dashboard. Report changed files and checks run. Leave changes ready for my review.`;
const harness = {
  name: "claude", capabilities: { permissionPrompts: true, thinking: true, mcp: true },
  models: [{ id: "opus", label: "Opus" }], builtInTools: [], commands: [], agents: [],
  account: { provider: "anthropic" },
};
const subscribe = (listener) => {
  queueMicrotask(() => listener({ type: "harness_list", harnesses: [harness] }));
  return noop;
};

function Launch() {
  const [input, setInput] = useState(prompt);
  const [data, setData] = useState({ ...LEADER_DEFAULT_DATA, taskName: "Improve the greeting project", worktreeIsolation: true });
  return <HarnessListProvider connected send={noop} subscribe={subscribe}>
    <ActivityLaunchForm nodeId="guide-leader" data={data} input={input} slashCommands={[]}
      promptPlaceholder="Describe the outcome" submitDisabled={false} submitActive
      textareaRef={createRef()} projectPath="/home/you/projects/minions-playground"
      onInputChange={setInput} onKeyDown={noop} onSubmit={noop}
      onUpdate={(patch) => setData({ ...data, ...patch })} />
  </HarnessListProvider>;
}

function Minions() {
  const taskPlan = titles.map((title, i) => ({
    taskId: `task-${i}`, title, description: title, priority: "medium",
    status: i === 0 ? "completed" : i === 3 ? "planned" : "running",
    executor: i === 0 || i === 3 ? "leader" : "minion",
    minionSessionKey: i === 1 || i === 2 ? `sample-minion-${i}` : null,
    result: i === 0 ? "Starter inspected; two independent file scopes." : null,
    cost: 0, createdAt: 0, completedAt: null, sessionSummary: "",
  }));
  return <>
    <div className="guide-plan"><TaskPlanPanel taskPlan={taskPlan} expanded onToggle={noop} onRevealMinion={noop} /></div>
    <div className="guide-workers">{[1, 2].map((i) => <div className="guide-worker" key={i}>
      <MinionNodeRenderer isSelected={false} onUpdateData={noop} node={{
        id: `sample-minion-${i}`, type: "minion", position: { x: 0, y: 0 }, size: { width: 540, height: 400 },
        data: { ...MINION_DEFAULT_DATA, status: "running", leaderId: "guide-leader", activeTaskIndex: 0,
          taskQueue: [{ taskId: `task-${i}`, title: titles[i], description: `Own only ${i === 1 ? "greet.mjs" : "USAGE.md"}.`,
            priority: "medium", status: "in_progress", activeStep: i === 1 ? "Checking named and default greetings" : "Documenting commands and expected output",
            progress: [], result: null }],
          streamingText: i === 1 ? "The greeting accepts a name argument. I am checking the default and named outputs." : "The usage notes include both commands and the expected greetings.",
        },
      }} />
    </div>)}</div>
  </>;
}

const graph = createGraphFixture(4);
const graphPlan = titles.map((title, i) => ({
  taskId: `node-${i}`, title, status: i === 0 ? "completed" : i === 3 ? "planned" : "running",
  executor: "minion",
}));
graph.title = "Improve the greeting project";
graph.groups = [];
graph.capacity = { running: 2, limit: 2 };
graph.budget = { spentUsd: 0, limitUsd: 5, tokens: 0 };
graph.evidence = [];
graph.criticalPath = { nodeIds: ["node-0", "node-1", "node-3"], observedMs: 30000, estimatedRemainingMs: 60000 };
graph.nodes = graph.nodes.map((node, i) => ({
  ...node, title: titles[i], objective: i === 3 ? "Run default and named greeting checks, then summarize the changes for review." : titles[i],
  constraints: [i === 1 ? "Write only greet.mjs" : i === 2 ? "Write only USAGE.md" : "Keep the change scoped"],
  acceptanceCriteria: [i === 3 ? "Both commands produce the expected greeting" : "Return a concise result and verification evidence"],
  stageId: undefined, logicalState: i === 0 ? "succeeded" : "pending",
  readiness: i === 1 || i === 2 ? "claimed" : i === 0 ? "terminal" : "not_ready",
  currentAttempt: i === 3 ? null : { ...node.currentAttempt, number: 1, state: i === 0 ? "succeeded" : "running", costUsd: 0, tokens: 0 },
  attemptHistory: [], verification: { state: "not_required", evidenceIds: [] },
  blocker: null, inputIds: [], outputArtifactIds: [], costUsd: 0, tokens: 0, owner: "Minion", logs: [],
}));
graph.edges = [[0, 1], [0, 2], [1, 3], [2, 3]].map(([source, target], i) => ({
  id: `edge-${i}`, source: `node-${source}`, target: `node-${target}`, type: "depends_on", state: "ordinary",
}));
graph.timeline = [];

const dashboard = {
  layout: { columns: 2, gap: 16 },
  components: [
    { id: "question", type: "form", title: "Choose the default greeting", description: "One product decision is needed before final verification.",
      fields: [{ id: "default", kind: "select", label: "When no name is supplied", required: true,
        options: [{ label: "Hello, world!", value: "world" }, { label: "Hello, friend!", value: "friend" }] }], submitLabel: "Send decision" },
    { id: "status", type: "status", label: "Greeting implementation", state: "success" },
    { id: "progress", type: "progress", label: "Plan progress", value: 75 },
    { id: "work", type: "table", headers: ["Owner", "File", "Result"], rows: [
      ["Code Minion", "greet.mjs", "Named greeting implemented"], ["Docs Minion", "USAGE.md", "Examples documented"],
      ["Leader", "Verification", "Waiting for default-greeting decision"],
    ] },
    { id: "checks", type: "checklist", items: [{ label: "Named greeting checked", checked: true }, { label: "Usage examples reviewed", checked: true }, { label: "Default greeting confirmed", checked: false }] },
  ],
};
dashboard.components.forEach((component) => renderComponentSchema.parse(component));

const scene = new URLSearchParams(location.search).get("scene") ?? "projects";
const headings = { launch: "Configure your first Leader", minions: "Follow the delegated work", graph: "Inspect dependencies and progress", dashboard: "See results and answer questions" };
createRoot(document.getElementById("root")).render(scene === "projects" ? <ProjectList onOpenProject={noop} /> :
  <main className="guide-scene">
    <header className="guide-heading"><span>MINIONS / GETTING STARTED</span><h1>{headings[scene]}</h1><p>Sample project · real application components · illustrative state</p></header>
    {scene === "launch" && <Launch />}
    {scene === "minions" && <Minions />}
    {scene === "dashboard" && <div className="guide-dashboard"><DashboardSurface renderState={dashboard} onSubmitForm={noop} /></div>}
    {scene === "graph" && <GraphInspector snapshot={graph} plan={graphPlan} onClose={noop} onAction={noop} />}
  </main>);
