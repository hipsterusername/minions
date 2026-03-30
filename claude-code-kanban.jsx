import { useState, useEffect, useRef, useCallback } from "react";

const COLUMNS = [
  { id: "backlog", label: "Backlog", icon: "◇" },
  { id: "todo", label: "To Do", icon: "○" },
  { id: "in_progress", label: "In Progress", icon: "◐" },
  { id: "review", label: "Review", icon: "◑" },
  { id: "done", label: "Done", icon: "●" },
];

const PRIORITY_COLORS = {
  low: { bg: "#1a3a2a", text: "#4ade80", dot: "#22c55e" },
  medium: { bg: "#3a3520", text: "#facc15", dot: "#eab308" },
  high: { bg: "#3a1a1a", text: "#f87171", dot: "#ef4444" },
  critical: { bg: "#4a0e1e", text: "#ff6b9d", dot: "#e11d48" },
};

const TAG_PALETTE = [
  { bg: "#1e293b", text: "#94a3b8", border: "#334155" },
  { bg: "#1a2744", text: "#60a5fa", border: "#1e3a5f" },
  { bg: "#1a3329", text: "#4ade80", border: "#1e4d3d" },
  { bg: "#362014", text: "#fb923c", border: "#4a2c1a" },
  { bg: "#2d1a3a", text: "#c084fc", border: "#3b1f52" },
  { bg: "#3a1a2e", text: "#f472b6", border: "#4a1f3a" },
];

function getTagColor(tag) {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = tag.charCodeAt(i) + ((hash << 5) - hash);
  return TAG_PALETTE[Math.abs(hash) % TAG_PALETTE.length];
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const STORAGE_KEY = "kanban-board-v1";

const SEED_TASKS = [
  // === PHASE 1: Project Foundation ===
  {
    id: "p1-scaffold", column: "todo", priority: "critical",
    title: "Scaffold React + Vite project",
    description: "Initialize the project with Vite, React, TypeScript. Set up ESM, tsconfig strict mode, oxlint, vitest. This is the container app that hosts both the canvas and the kanban.",
    tags: ["infra", "phase-1"],
    subtasks: [
      { id: "s1", text: "pnpm create vite with React + TS template", done: false },
      { id: "s2", text: "Configure tsconfig strict settings", done: false },
      { id: "s3", text: "Add oxlint + oxfmt", done: false },
      { id: "s4", text: "Set up vitest", done: false },
      { id: "s5", text: "Add base CSS reset and dark theme vars", done: false },
    ],
    created: Date.now(), updated: Date.now(),
  },
  {
    id: "p1-canvas-foundation", column: "todo", priority: "critical",
    title: "Infinite canvas with pan and zoom",
    description: "Core canvas component using CSS transforms (translate + scale). Mouse drag to pan, scroll wheel to zoom. This is the foundation everything else sits on. Use a single transform origin with matrix math - no libraries.",
    tags: ["canvas", "phase-1"],
    subtasks: [
      { id: "s1", text: "Canvas container with full viewport sizing", done: false },
      { id: "s2", text: "Pan via mouse drag (middle-click or space+drag)", done: false },
      { id: "s3", text: "Zoom via scroll wheel centered on cursor", done: false },
      { id: "s4", text: "Transform state: { x, y, scale }", done: false },
      { id: "s5", text: "Dot grid background that scales with zoom", done: false },
      { id: "s6", text: "Zoom limits (0.1x - 5x)", done: false },
    ],
    created: Date.now(), updated: Date.now(),
  },
  {
    id: "p1-node-system", column: "todo", priority: "critical",
    title: "Base node system on canvas",
    description: "Generic node abstraction: each node has position {x,y}, size, type, and data. Nodes render inside the canvas transform space. Draggable nodes that snap-to-grid optionally. Node registry pattern so new types can be added easily.",
    tags: ["canvas", "phase-1"],
    subtasks: [
      { id: "s1", text: "Node data model: id, type, position, size, data", done: false },
      { id: "s2", text: "Canvas state store (useReducer or zustand)", done: false },
      { id: "s3", text: "Node rendering in transform space", done: false },
      { id: "s4", text: "Node dragging with canvas-aware coordinates", done: false },
      { id: "s5", text: "Node type registry for extensibility", done: false },
    ],
    created: Date.now(), updated: Date.now(),
  },

  // === PHASE 2: Canvas Features ===
  {
    id: "p2-selection", column: "backlog", priority: "high",
    title: "Node selection and multi-select",
    description: "Click to select a node (highlighted border). Shift+click for multi-select. Drag selection rectangle (marquee) on empty canvas. Selected nodes can be moved together. Delete key removes selected nodes.",
    tags: ["canvas", "phase-2"],
    subtasks: [
      { id: "s1", text: "Single node selection with visual indicator", done: false },
      { id: "s2", text: "Multi-select with shift+click", done: false },
      { id: "s3", text: "Marquee/lasso selection on canvas drag", done: false },
      { id: "s4", text: "Batch move selected nodes", done: false },
      { id: "s5", text: "Delete selected nodes", done: false },
    ],
    created: Date.now(), updated: Date.now(),
  },
  {
    id: "p2-edges", column: "backlog", priority: "high",
    title: "Connection/edge system between nodes",
    description: "Nodes have input/output ports. Drag from an output port to an input port to create a directed edge. Edges render as SVG curves (bezier) in the canvas transform space. Edges represent data flow: output of one Claude session can feed into another.",
    tags: ["canvas", "phase-2"],
    subtasks: [
      { id: "s1", text: "Port component on node edges (in/out)", done: false },
      { id: "s2", text: "Drag-to-connect interaction", done: false },
      { id: "s3", text: "SVG bezier curve rendering", done: false },
      { id: "s4", text: "Edge data model in canvas state", done: false },
      { id: "s5", text: "Delete edges (click + delete or backspace)", done: false },
    ],
    created: Date.now(), updated: Date.now(),
  },
  {
    id: "p2-minimap", column: "backlog", priority: "medium",
    title: "Minimap navigation widget",
    description: "Small overview of the full canvas in corner. Shows node positions as dots/rectangles. Viewport rectangle shows current view. Click minimap to navigate. Drag viewport rectangle to pan.",
    tags: ["canvas", "phase-2"],
    subtasks: [
      { id: "s1", text: "Calculate bounding box of all nodes", done: false },
      { id: "s2", text: "Render scaled-down node positions", done: false },
      { id: "s3", text: "Show viewport rectangle", done: false },
      { id: "s4", text: "Click-to-navigate and drag-to-pan", done: false },
    ],
    created: Date.now(), updated: Date.now(),
  },
  {
    id: "p2-toolbar", column: "backlog", priority: "high",
    title: "Canvas toolbar and controls",
    description: "Floating toolbar with: add node (opens palette), zoom in/out/reset, fit-to-view, toggle grid. Keyboard shortcuts: space=pan mode, z=zoom tool, delete=remove, cmd+a=select all, cmd+0=fit view.",
    tags: ["canvas", "ux", "phase-2"],
    subtasks: [
      { id: "s1", text: "Floating toolbar component", done: false },
      { id: "s2", text: "Node palette dropdown/popover", done: false },
      { id: "s3", text: "Zoom controls (in/out/reset/fit)", done: false },
      { id: "s4", text: "Keyboard shortcut system", done: false },
      { id: "s5", text: "Grid toggle", done: false },
    ],
    created: Date.now(), updated: Date.now(),
  },

  // === PHASE 3: Claude Code Integration ===
  {
    id: "p3-claude-connection", column: "backlog", priority: "critical",
    title: "Claude Code process connection layer",
    description: "Backend service (or Electron/Tauri shell) that spawns and manages Claude Code CLI processes. Exposes a WebSocket API: start session, send input, receive streaming output, kill session. Each session is an independent Claude Code process.",
    tags: ["claude", "backend", "phase-3"],
    subtasks: [
      { id: "s1", text: "Decide runtime: Electron, Tauri, or local server", done: false },
      { id: "s2", text: "PTY spawn for Claude Code process", done: false },
      { id: "s3", text: "WebSocket server for frontend communication", done: false },
      { id: "s4", text: "Session lifecycle: create, attach, detach, kill", done: false },
      { id: "s5", text: "Stream stdout/stderr to frontend", done: false },
      { id: "s6", text: "Send stdin from frontend to process", done: false },
    ],
    created: Date.now(), updated: Date.now(),
  },
  {
    id: "p3-terminal-node", column: "backlog", priority: "critical",
    title: "Claude Code terminal node type",
    description: "A canvas node that embeds a terminal emulator (xterm.js). Shows Claude Code output with ANSI color support. Input field at bottom to send commands. Header shows session status (running/idle/stopped). Resizable.",
    tags: ["claude", "canvas", "phase-3"],
    subtasks: [
      { id: "s1", text: "Integrate xterm.js in a canvas node", done: false },
      { id: "s2", text: "Connect to WebSocket session", done: false },
      { id: "s3", text: "Stream output rendering with ANSI colors", done: false },
      { id: "s4", text: "Input field with command history", done: false },
      { id: "s5", text: "Session status indicator in header", done: false },
      { id: "s6", text: "Node resize handling", done: false },
    ],
    created: Date.now(), updated: Date.now(),
  },
  {
    id: "p3-session-mgmt", column: "backlog", priority: "high",
    title: "Session management and persistence",
    description: "Track all active Claude Code sessions. Reconnect to running sessions on page reload. Session history with timestamps. Allow naming sessions. Show resource usage (if available).",
    tags: ["claude", "phase-3"],
    subtasks: [
      { id: "s1", text: "Session registry with metadata", done: false },
      { id: "s2", text: "Reconnect on page reload", done: false },
      { id: "s3", text: "Session naming and labeling", done: false },
      { id: "s4", text: "Session history log", done: false },
    ],
    created: Date.now(), updated: Date.now(),
  },

  // === PHASE 4: Node Types ===
  {
    id: "p4-prompt-node", column: "backlog", priority: "high",
    title: "Prompt/instruction node type",
    description: "A text editor node where you write prompts or instructions. Has a 'Send to Claude' button that pipes the text to a connected Claude Code session node. Supports markdown editing. Can template variables from connected input nodes.",
    tags: ["nodes", "phase-4"],
    subtasks: [
      { id: "s1", text: "Rich text/markdown input area", done: false },
      { id: "s2", text: "Send-to-connected-session action", done: false },
      { id: "s3", text: "Variable interpolation from connected nodes", done: false },
    ],
    created: Date.now(), updated: Date.now(),
  },
  {
    id: "p4-file-node", column: "backlog", priority: "medium",
    title: "File viewer node type",
    description: "Displays file contents with syntax highlighting. Can be pointed at a file path. Auto-refreshes when file changes (via fs watch). Read-only by default. Could connect to Claude output to show files it modified.",
    tags: ["nodes", "phase-4"],
    subtasks: [
      { id: "s1", text: "File path input and content display", done: false },
      { id: "s2", text: "Syntax highlighting (highlight.js or shiki)", done: false },
      { id: "s3", text: "File watch and auto-refresh", done: false },
      { id: "s4", text: "Connect to Claude session for modified files", done: false },
    ],
    created: Date.now(), updated: Date.now(),
  },
  {
    id: "p4-note-node", column: "backlog", priority: "low",
    title: "Sticky note / text annotation node",
    description: "Simple freeform text node for annotations on the canvas. Multiple color options. Resizable. Useful for documenting the canvas layout and leaving context for yourself.",
    tags: ["nodes", "phase-4"],
    subtasks: [
      { id: "s1", text: "Editable text area node", done: false },
      { id: "s2", text: "Color picker for note background", done: false },
      { id: "s3", text: "Auto-resize or manual resize", done: false },
    ],
    created: Date.now(), updated: Date.now(),
  },
  {
    id: "p4-kanban-node", column: "backlog", priority: "medium",
    title: "Embed kanban board as a canvas node",
    description: "The existing kanban board component rendered inside a canvas node. Scrollable within the node. Allows task management without leaving the canvas. This connects the planning layer to the execution layer.",
    tags: ["nodes", "kanban", "phase-4"],
    subtasks: [
      { id: "s1", text: "Wrap existing KanbanBoard in a canvas node", done: false },
      { id: "s2", text: "Handle scroll isolation (node vs canvas)", done: false },
      { id: "s3", text: "Bidirectional: drag task to create prompt node", done: false },
    ],
    created: Date.now(), updated: Date.now(),
  },

  // === PHASE 5: Canvas UX Polish ===
  {
    id: "p5-context-menu", column: "backlog", priority: "medium",
    title: "Context menu system",
    description: "Right-click on canvas: add node, paste, fit view. Right-click on node: duplicate, delete, disconnect, change type. Right-click on edge: delete, inspect. Clean dark-themed menu matching the existing design language.",
    tags: ["ux", "phase-5"],
    subtasks: [
      { id: "s1", text: "Canvas context menu", done: false },
      { id: "s2", text: "Node context menu", done: false },
      { id: "s3", text: "Edge context menu", done: false },
    ],
    created: Date.now(), updated: Date.now(),
  },
  {
    id: "p5-persistence", column: "backlog", priority: "high",
    title: "Canvas state persistence",
    description: "Save full canvas state (nodes, edges, positions, zoom) to local storage or file. Auto-save on changes with debounce. Load canvas on startup. Export/import canvas as JSON.",
    tags: ["infra", "phase-5"],
    subtasks: [
      { id: "s1", text: "Serialize canvas state to JSON", done: false },
      { id: "s2", text: "Auto-save with debounce", done: false },
      { id: "s3", text: "Load on startup", done: false },
      { id: "s4", text: "Export/import canvas file", done: false },
    ],
    created: Date.now(), updated: Date.now(),
  },
  {
    id: "p5-auto-layout", column: "backlog", priority: "low",
    title: "Auto-layout and arrangement",
    description: "Button to auto-arrange nodes in a clean layout (dagre or elk algorithm). Options: horizontal flow, vertical flow, force-directed. Animate the transition. Useful when the canvas gets messy.",
    tags: ["ux", "phase-5"],
    subtasks: [
      { id: "s1", text: "Integrate layout algorithm (dagre)", done: false },
      { id: "s2", text: "Layout direction options", done: false },
      { id: "s3", text: "Animated transition to new positions", done: false },
    ],
    created: Date.now(), updated: Date.now(),
  },

  // === PHASE 6: Advanced ===
  {
    id: "p6-multi-session", column: "backlog", priority: "medium",
    title: "Multiple concurrent Claude Code sessions",
    description: "Run several Claude Code instances simultaneously on the canvas. Each terminal node is its own session. Enable parallel task execution - one Claude works on frontend while another handles backend.",
    tags: ["claude", "phase-6"],
    subtasks: [
      { id: "s1", text: "Session pool management", done: false },
      { id: "s2", text: "Visual differentiation of sessions", done: false },
      { id: "s3", text: "Resource monitoring per session", done: false },
    ],
    created: Date.now(), updated: Date.now(),
  },
  {
    id: "p6-chaining", column: "backlog", priority: "medium",
    title: "Prompt chaining via edges",
    description: "Connect prompt nodes to Claude sessions to file viewers in a pipeline. Output of one Claude session becomes input to the next. Enables multi-step workflows: plan -> implement -> test -> review, each as a separate Claude session with outputs flowing forward.",
    tags: ["claude", "canvas", "phase-6"],
    subtasks: [
      { id: "s1", text: "Define data flow protocol between nodes", done: false },
      { id: "s2", text: "Auto-trigger downstream nodes on completion", done: false },
      { id: "s3", text: "Pipeline status visualization", done: false },
      { id: "s4", text: "Error handling and retry in pipelines", done: false },
    ],
    created: Date.now(), updated: Date.now(),
  },
  {
    id: "p6-git-node", column: "backlog", priority: "low",
    title: "Git status and diff node",
    description: "A node that shows current git status, staged changes, recent commits, and diffs. Useful for monitoring what Claude Code is doing to the repo in real-time.",
    tags: ["nodes", "phase-6"],
    subtasks: [
      { id: "s1", text: "Git status display (modified, staged, untracked)", done: false },
      { id: "s2", text: "Diff viewer with syntax highlighting", done: false },
      { id: "s3", text: "Recent commits list", done: false },
      { id: "s4", text: "Auto-refresh on file system changes", done: false },
    ],
    created: Date.now(), updated: Date.now(),
  },
];

function ClaudeCommandModal({ task, onClose }) {
  const [copied, setCopied] = useState(null);
  const modalRef = useRef();

  useEffect(() => {
    const handler = (e) => {
      if (modalRef.current && !modalRef.current.contains(e.target)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const commands = [
    {
      label: "Implement task",
      desc: "Start working on this task",
      cmd: `claude "Implement the following task: ${task.title}. ${task.description || ""} ${task.tags?.length ? `Tags: ${task.tags.join(", ")}` : ""} Priority: ${task.priority}. Please analyze the codebase first, then implement the changes needed."`,
    },
    {
      label: "Plan approach",
      desc: "Get a plan before coding",
      cmd: `claude "I need to: ${task.title}. ${task.description || ""} Don't write any code yet. Analyze the codebase and give me a detailed plan of what files need to change and how."`,
    },
    {
      label: "Review implementation",
      desc: "Review code related to this task",
      cmd: `claude "Review the implementation for: ${task.title}. ${task.description || ""} Check for bugs, edge cases, performance issues, and suggest improvements."`,
    },
    {
      label: "Write tests",
      desc: "Generate tests for this task",
      cmd: `claude "Write comprehensive tests for: ${task.title}. ${task.description || ""} Include unit tests and edge cases. Follow existing test patterns in the codebase."`,
    },
  ];

  const copyCmd = (cmd, idx) => {
    navigator.clipboard.writeText(cmd);
    setCopied(idx);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
      backdropFilter: "blur(8px)", display: "flex", alignItems: "center",
      justifyContent: "center", zIndex: 1000, padding: "20px",
    }}>
      <div ref={modalRef} style={{
        background: "#0f1117", border: "1px solid #1e2030", borderRadius: 16,
        width: "100%", maxWidth: 640, maxHeight: "85vh", overflow: "auto",
        boxShadow: "0 25px 60px rgba(0,0,0,0.5)",
      }}>
        <div style={{
          padding: "24px 28px 16px", borderBottom: "1px solid #1e2030",
          display: "flex", justifyContent: "space-between", alignItems: "flex-start",
        }}>
          <div>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 2, color: "#f0883e", marginBottom: 6, fontFamily: "'JetBrains Mono', monospace" }}>
              Claude Code Commands
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "#e2e8f0" }}>{task.title}</div>
          </div>
          <button onClick={onClose} style={{
            background: "none", border: "none", color: "#4a5068", fontSize: 22,
            cursor: "pointer", padding: 4, lineHeight: 1,
          }}>✕</button>
        </div>
        <div style={{ padding: "16px 28px 28px", display: "flex", flexDirection: "column", gap: 12 }}>
          {commands.map((c, i) => (
            <div key={i} style={{
              background: "#141620", border: "1px solid #1e2030", borderRadius: 10,
              padding: "14px 16px", cursor: "pointer", transition: "all 0.15s",
            }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = "#f0883e40"; e.currentTarget.style.background = "#181c2a"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "#1e2030"; e.currentTarget.style.background = "#141620"; }}
              onClick={() => copyCmd(c.cmd, i)}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0" }}>{c.label}</span>
                <span style={{
                  fontSize: 11, color: copied === i ? "#4ade80" : "#4a5068",
                  fontFamily: "'JetBrains Mono', monospace", transition: "color 0.2s",
                }}>
                  {copied === i ? "✓ copied" : "click to copy"}
                </span>
              </div>
              <div style={{ fontSize: 11, color: "#64748b", marginBottom: 10 }}>{c.desc}</div>
              <pre style={{
                margin: 0, padding: "10px 12px", background: "#0a0c14", borderRadius: 6,
                fontSize: 11, color: "#a0aec0", fontFamily: "'JetBrains Mono', monospace",
                whiteSpace: "pre-wrap", wordBreak: "break-all", lineHeight: 1.5,
                border: "1px solid #1a1d2e",
              }}>{c.cmd}</pre>
            </div>
          ))}
          <div style={{ fontSize: 11, color: "#3a3f55", textAlign: "center", marginTop: 4, fontStyle: "italic" }}>
            Paste any command into your terminal to run with Claude Code
          </div>
        </div>
      </div>
    </div>
  );
}

function TaskModal({ task, onSave, onDelete, onClose, isNew }) {
  const [form, setForm] = useState({
    title: task?.title || "",
    description: task?.description || "",
    priority: task?.priority || "medium",
    tags: task?.tags?.join(", ") || "",
    subtasks: task?.subtasks || [],
  });
  const modalRef = useRef();

  useEffect(() => {
    const handler = (e) => {
      if (modalRef.current && !modalRef.current.contains(e.target)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const handleSave = () => {
    if (!form.title.trim()) return;
    onSave({
      ...task,
      title: form.title.trim(),
      description: form.description.trim(),
      priority: form.priority,
      tags: form.tags.split(",").map(t => t.trim()).filter(Boolean),
      subtasks: form.subtasks,
    });
  };

  const toggleSubtask = (i) => {
    const updated = [...form.subtasks];
    updated[i] = { ...updated[i], done: !updated[i].done };
    setForm(f => ({ ...f, subtasks: updated }));
  };

  const addSubtask = () => {
    setForm(f => ({ ...f, subtasks: [...f.subtasks, { id: uid(), text: "", done: false }] }));
  };

  const updateSubtaskText = (i, text) => {
    const updated = [...form.subtasks];
    updated[i] = { ...updated[i], text };
    setForm(f => ({ ...f, subtasks: updated }));
  };

  const removeSubtask = (i) => {
    setForm(f => ({ ...f, subtasks: f.subtasks.filter((_, idx) => idx !== i) }));
  };

  const inputStyle = {
    width: "100%", padding: "10px 12px", background: "#141620",
    border: "1px solid #1e2030", borderRadius: 8, color: "#e2e8f0",
    fontSize: 13, outline: "none", fontFamily: "inherit", boxSizing: "border-box",
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
      backdropFilter: "blur(8px)", display: "flex", alignItems: "center",
      justifyContent: "center", zIndex: 1000, padding: "20px",
    }}>
      <div ref={modalRef} style={{
        background: "#0f1117", border: "1px solid #1e2030", borderRadius: 16,
        width: "100%", maxWidth: 520, maxHeight: "85vh", overflow: "auto",
        boxShadow: "0 25px 60px rgba(0,0,0,0.5)",
      }}>
        <div style={{ padding: "24px 28px 16px", borderBottom: "1px solid #1e2030", display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontSize: 16, fontWeight: 600, color: "#e2e8f0" }}>{isNew ? "New Task" : "Edit Task"}</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#4a5068", fontSize: 22, cursor: "pointer", padding: 4, lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ padding: "20px 28px 28px", display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <label style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, display: "block" }}>Title</label>
            <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder="What needs to be done?" style={inputStyle} autoFocus
              onKeyDown={e => e.key === "Enter" && handleSave()} />
          </div>
          <div>
            <label style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, display: "block" }}>Description</label>
            <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Add details, acceptance criteria, context..."
              style={{ ...inputStyle, minHeight: 80, resize: "vertical" }} />
          </div>
          <div>
            <label style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, display: "block" }}>Priority</label>
            <div style={{ display: "flex", gap: 8 }}>
              {Object.keys(PRIORITY_COLORS).map(p => (
                <button key={p} onClick={() => setForm(f => ({ ...f, priority: p }))} style={{
                  flex: 1, padding: "8px 0", borderRadius: 6, border: `1px solid ${form.priority === p ? PRIORITY_COLORS[p].dot : "#1e2030"}`,
                  background: form.priority === p ? PRIORITY_COLORS[p].bg : "#141620",
                  color: form.priority === p ? PRIORITY_COLORS[p].text : "#4a5068",
                  fontSize: 12, fontWeight: 500, cursor: "pointer", textTransform: "capitalize", transition: "all 0.15s",
                }}>{p}</button>
              ))}
            </div>
          </div>
          <div>
            <label style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, display: "block" }}>Tags (comma separated)</label>
            <input value={form.tags} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))}
              placeholder="frontend, api, bug, feature..." style={inputStyle} />
          </div>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <label style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: 1 }}>Subtasks</label>
              <button onClick={addSubtask} style={{
                background: "none", border: "1px solid #1e2030", borderRadius: 6, color: "#64748b",
                fontSize: 11, padding: "4px 10px", cursor: "pointer",
              }}>+ Add</button>
            </div>
            {form.subtasks.map((st, i) => (
              <div key={st.id} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                <button onClick={() => toggleSubtask(i)} style={{
                  width: 18, height: 18, borderRadius: 4, flexShrink: 0,
                  border: `1px solid ${st.done ? "#4ade80" : "#2a2f42"}`,
                  background: st.done ? "#1a3a2a" : "transparent",
                  color: st.done ? "#4ade80" : "transparent", fontSize: 10,
                  cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                }}>✓</button>
                <input value={st.text} onChange={e => updateSubtaskText(i, e.target.value)}
                  placeholder="Subtask..." style={{ ...inputStyle, padding: "6px 10px", fontSize: 12, textDecoration: st.done ? "line-through" : "none", opacity: st.done ? 0.5 : 1 }} />
                <button onClick={() => removeSubtask(i)} style={{
                  background: "none", border: "none", color: "#3a1a1a", fontSize: 14, cursor: "pointer", padding: "0 4px", flexShrink: 0,
                }}>✕</button>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            {!isNew && (
              <button onClick={() => onDelete(task.id)} style={{
                padding: "10px 16px", borderRadius: 8, border: "1px solid #3a1a1a",
                background: "#1a0a0a", color: "#f87171", fontSize: 13, cursor: "pointer", fontWeight: 500,
              }}>Delete</button>
            )}
            <div style={{ flex: 1 }} />
            <button onClick={onClose} style={{
              padding: "10px 20px", borderRadius: 8, border: "1px solid #1e2030",
              background: "#141620", color: "#94a3b8", fontSize: 13, cursor: "pointer",
            }}>Cancel</button>
            <button onClick={handleSave} style={{
              padding: "10px 24px", borderRadius: 8, border: "none",
              background: "linear-gradient(135deg, #f0883e, #e05b2a)", color: "#fff",
              fontSize: 13, fontWeight: 600, cursor: "pointer",
            }}>Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TaskCard({ task, onEdit, onSendToClaude, onDragStart }) {
  const doneCount = task.subtasks?.filter(s => s.done).length || 0;
  const totalSubs = task.subtasks?.length || 0;
  const p = PRIORITY_COLORS[task.priority] || PRIORITY_COLORS.medium;

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", task.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart(task.id);
      }}
      style={{
        background: "#141620", border: "1px solid #1e2030", borderRadius: 10,
        padding: "14px 16px", cursor: "grab", transition: "all 0.15s",
        borderLeft: `3px solid ${p.dot}`,
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = "#2a3050"; e.currentTarget.style.transform = "translateY(-1px)"; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = "#1e2030"; e.currentTarget.style.transform = "none"; }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: "#e2e8f0", lineHeight: 1.4, flex: 1, marginRight: 8 }}>{task.title}</span>
        <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
          <button onClick={(e) => { e.stopPropagation(); onSendToClaude(task); }} title="Claude Code commands" style={{
            width: 26, height: 26, borderRadius: 6, border: "none", cursor: "pointer", fontSize: 13,
            background: "transparent", color: "#f0883e", display: "flex", alignItems: "center", justifyContent: "center",
            transition: "background 0.15s",
          }}
            onMouseEnter={e => e.currentTarget.style.background = "#1e2030"}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}
          >⌘</button>
          <button onClick={(e) => { e.stopPropagation(); onEdit(task); }} title="Edit task" style={{
            width: 26, height: 26, borderRadius: 6, border: "none", cursor: "pointer", fontSize: 11,
            background: "transparent", color: "#4a5068", display: "flex", alignItems: "center", justifyContent: "center",
            transition: "background 0.15s",
          }}
            onMouseEnter={e => e.currentTarget.style.background = "#1e2030"}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}
          >✎</button>
        </div>
      </div>
      {task.description && (
        <div style={{ fontSize: 11, color: "#4a5068", lineHeight: 1.5, marginBottom: 8, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {task.description}
        </div>
      )}
      {task.tags?.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
          {task.tags.map((tag, i) => {
            const tc = getTagColor(tag);
            return (
              <span key={i} style={{
                fontSize: 10, padding: "2px 8px", borderRadius: 4,
                background: tc.bg, color: tc.text, border: `1px solid ${tc.border}`,
                fontFamily: "'JetBrains Mono', monospace",
              }}>{tag}</span>
            );
          })}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{
          fontSize: 10, padding: "2px 8px", borderRadius: 4,
          background: p.bg, color: p.text, textTransform: "uppercase",
          fontWeight: 600, letterSpacing: 0.5, fontFamily: "'JetBrains Mono', monospace",
        }}>
          <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: p.dot, marginRight: 4, verticalAlign: "middle" }} />
          {task.priority}
        </span>
        {totalSubs > 0 && (
          <span style={{ fontSize: 10, color: "#4a5068", fontFamily: "'JetBrains Mono', monospace" }}>
            {doneCount}/{totalSubs} done
          </span>
        )}
      </div>
    </div>
  );
}

export default function KanbanBoard() {
  const [tasks, setTasks] = useState([]);
  const [editingTask, setEditingTask] = useState(null);
  const [claudeTask, setClaudeTask] = useState(null);
  const [newTaskColumn, setNewTaskColumn] = useState(null);
  const [dragOverCol, setDragOverCol] = useState(null);
  const [draggingId, setDraggingId] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [filterTag, setFilterTag] = useState(null);
  const [filterPriority, setFilterPriority] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Load from storage
  useEffect(() => {
    (async () => {
      try {
        const result = await window.storage.get(STORAGE_KEY);
        if (result?.value) {
          setTasks(JSON.parse(result.value));
        } else {
          setTasks(SEED_TASKS);
        }
      } catch { }
      setLoaded(true);
    })();
  }, []);

  // Save to storage
  useEffect(() => {
    if (!loaded) return;
    (async () => {
      try {
        await window.storage.set(STORAGE_KEY, JSON.stringify(tasks));
      } catch { }
    })();
  }, [tasks, loaded]);

  const saveTask = useCallback((updatedTask) => {
    setTasks(prev => {
      const exists = prev.find(t => t.id === updatedTask.id);
      if (exists) return prev.map(t => t.id === updatedTask.id ? { ...updatedTask, updated: Date.now() } : t);
      return [...prev, { ...updatedTask, id: uid(), created: Date.now(), updated: Date.now() }];
    });
    setEditingTask(null);
    setNewTaskColumn(null);
  }, []);

  const deleteTask = useCallback((id) => {
    setTasks(prev => prev.filter(t => t.id !== id));
    setEditingTask(null);
  }, []);

  const handleDrop = useCallback((colId, e) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData("text/plain");
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, column: colId, updated: Date.now() } : t));
    setDragOverCol(null);
    setDraggingId(null);
  }, []);

  const allTags = [...new Set(tasks.flatMap(t => t.tags || []))];

  const filteredTasks = tasks.filter(t => {
    if (filterTag && !(t.tags || []).includes(filterTag)) return false;
    if (filterPriority && t.priority !== filterPriority) return false;
    if (searchQuery && !t.title.toLowerCase().includes(searchQuery.toLowerCase()) &&
      !(t.description || "").toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const colCounts = {};
  COLUMNS.forEach(c => { colCounts[c.id] = filteredTasks.filter(t => t.column === c.id).length; });

  if (!loaded) {
    return (
      <div style={{ background: "#0a0c14", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "#4a5068", fontSize: 14 }}>Loading board...</div>
      </div>
    );
  }

  return (
    <div style={{
      background: "#0a0c14", minHeight: "100vh", fontFamily: "'DM Sans', 'Segoe UI', sans-serif",
      display: "flex", flexDirection: "column",
    }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={{
        padding: "20px 28px", borderBottom: "1px solid #1a1d2e",
        display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: "linear-gradient(135deg, #f0883e, #e05b2a)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 16, color: "#fff", fontWeight: 700,
          }}>⌘</div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#e2e8f0", letterSpacing: -0.3 }}>
              Claude Code Kanban
            </div>
            <div style={{ fontSize: 11, color: "#4a5068", fontFamily: "'JetBrains Mono', monospace" }}>
              {tasks.length} task{tasks.length !== 1 ? "s" : ""} · {tasks.filter(t => t.column === "done").length} completed
            </div>
          </div>
        </div>

        {/* Search */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search tasks..."
            style={{
              padding: "7px 12px", background: "#141620", border: "1px solid #1e2030",
              borderRadius: 8, color: "#e2e8f0", fontSize: 12, outline: "none", width: 180,
              fontFamily: "inherit",
            }}
          />

          {/* Priority filter */}
          <select
            value={filterPriority || ""}
            onChange={e => setFilterPriority(e.target.value || null)}
            style={{
              padding: "7px 10px", background: "#141620", border: "1px solid #1e2030",
              borderRadius: 8, color: "#94a3b8", fontSize: 12, outline: "none",
              fontFamily: "inherit", cursor: "pointer",
            }}
          >
            <option value="">All priorities</option>
            {Object.keys(PRIORITY_COLORS).map(p => (
              <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
            ))}
          </select>

          {/* Tag filter */}
          {allTags.length > 0 && (
            <select
              value={filterTag || ""}
              onChange={e => setFilterTag(e.target.value || null)}
              style={{
                padding: "7px 10px", background: "#141620", border: "1px solid #1e2030",
                borderRadius: 8, color: "#94a3b8", fontSize: 12, outline: "none",
                fontFamily: "inherit", cursor: "pointer",
              }}
            >
              <option value="">All tags</option>
              {allTags.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
        </div>
      </div>

      {/* Board */}
      <div style={{
        flex: 1, display: "flex", gap: 0, overflowX: "auto", padding: "0",
      }}>
        {COLUMNS.map((col) => {
          const colTasks = filteredTasks.filter(t => t.column === col.id).sort((a, b) => {
            const pOrder = { critical: 0, high: 1, medium: 2, low: 3 };
            return (pOrder[a.priority] ?? 2) - (pOrder[b.priority] ?? 2);
          });
          const isOver = dragOverCol === col.id;

          return (
            <div
              key={col.id}
              onDragOver={(e) => { e.preventDefault(); setDragOverCol(col.id); }}
              onDragLeave={() => setDragOverCol(null)}
              onDrop={(e) => handleDrop(col.id, e)}
              style={{
                flex: 1, minWidth: 240, display: "flex", flexDirection: "column",
                borderRight: "1px solid #12141e",
                background: isOver ? "#0d0f1a" : "transparent",
                transition: "background 0.2s",
              }}
            >
              {/* Column header */}
              <div style={{
                padding: "16px 16px 12px", display: "flex", justifyContent: "space-between",
                alignItems: "center", borderBottom: "1px solid #12141e",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 14, opacity: 0.5 }}>{col.icon}</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 1 }}>
                    {col.label}
                  </span>
                  <span style={{
                    fontSize: 10, padding: "2px 7px", borderRadius: 10,
                    background: "#1a1d2e", color: "#4a5068", fontFamily: "'JetBrains Mono', monospace",
                  }}>{colCounts[col.id]}</span>
                </div>
                <button
                  onClick={() => setNewTaskColumn(col.id)}
                  style={{
                    width: 24, height: 24, borderRadius: 6, border: "1px solid #1e2030",
                    background: "transparent", color: "#4a5068", fontSize: 16,
                    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                    lineHeight: 1, transition: "all 0.15s",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = "#f0883e"; e.currentTarget.style.color = "#f0883e"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = "#1e2030"; e.currentTarget.style.color = "#4a5068"; }}
                >+</button>
              </div>

              {/* Cards */}
              <div style={{ flex: 1, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 8, overflowY: "auto" }}>
                {colTasks.map(task => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    onEdit={setEditingTask}
                    onSendToClaude={setClaudeTask}
                    onDragStart={setDraggingId}
                  />
                ))}
                {colTasks.length === 0 && (
                  <div style={{
                    padding: "32px 16px", textAlign: "center", color: "#1e2030",
                    fontSize: 12, fontStyle: "italic",
                    border: isOver ? "2px dashed #f0883e40" : "2px dashed transparent",
                    borderRadius: 10, transition: "all 0.2s",
                  }}>
                    {isOver ? "Drop here" : "No tasks"}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Modals */}
      {editingTask && (
        <TaskModal task={editingTask} onSave={saveTask} onDelete={deleteTask} onClose={() => setEditingTask(null)} />
      )}
      {newTaskColumn && (
        <TaskModal
          isNew
          task={{ column: newTaskColumn, priority: "medium", tags: [], subtasks: [] }}
          onSave={saveTask}
          onClose={() => setNewTaskColumn(null)}
        />
      )}
      {claudeTask && (
        <ClaudeCommandModal task={claudeTask} onClose={() => setClaudeTask(null)} />
      )}
    </div>
  );
}
