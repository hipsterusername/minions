import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Plus, Search, X } from "lucide-react";
import { zoneSummary, type CanvasZone } from "../canvas-zones.ts";
import type { CanvasNode } from "../types.ts";
import { WorkspaceIcon } from "./WorkspaceIcon.tsx";
import "./workspace-picker.css";

export function WorkspacePicker({ workspaces, nodes, value, currentId, onChange, onCreate, disabled = false, active = true }: {
  workspaces: CanvasZone[];
  nodes: CanvasNode[];
  value: string;
  currentId: string;
  onChange: (id: string) => void;
  onCreate?: ((name: string) => string) | undefined;
  disabled?: boolean;
  active?: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const open = expanded && active && !disabled;
  const selected = workspaces.find(workspace => workspace.id === value) ?? workspaces[0];
  const matches = workspaces.filter(workspace => workspace.data.name.toLowerCase().includes(query.trim().toLowerCase()));
  const leaders = new Map(nodes.filter(node => node.type === "leader").map(node => [node.id, node]));

  function close(restoreFocus = false) {
    setExpanded(false);
    if (restoreFocus) trigger.current?.focus();
  }

  useEffect(() => { if (!active || disabled) setExpanded(false); }, [active, disabled]);
  useEffect(() => { if (!open) setCreating(false); }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const element = panel.current!;
    const viewport = window.visualViewport;
    const position = () => {
      const anchor = trigger.current!.getBoundingClientRect();
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
      element.style.width = `${Math.min(360, width - 24)}px`;
      element.style.maxHeight = `${Math.max(80, height - 24)}px`;
      const box = element.getBoundingClientRect();
      const y = anchor.bottom + 8 + box.height <= top + height - 12
        ? anchor.bottom + 8 : anchor.top - box.height - 8;
      element.style.left = `${Math.max(left + 12, Math.min(anchor.right - box.width, left + width - box.width - 12))}px`;
      element.style.top = `${Math.max(top + 12, Math.min(y, top + height - box.height - 12))}px`;
    };
    position();
    search.current?.focus({ preventScroll: true });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(position);
    observer?.observe(element);
    const dismissOutside = (event: Event) => {
      if (!element.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setExpanded(false);
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    return () => {
      observer?.disconnect();
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
    };
  }, [open]);

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); close(true); return;
    }
    if (creating) return;
    const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("[data-workspace-choice]") ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const inSearch = event.target === search.current;
    if (inSearch && event.key === "Enter") {
      event.preventDefault(); buttons[0]?.click(); return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || (inSearch && ["Home", "End"].includes(event.key))) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" || (inSearch && event.key === "ArrowUp") ? buttons.length - 1
      : Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
    buttons[next]?.focus();
  }

  if (!selected) return null;
  return <div className="leader-launch-workspace workspace-picker">
    <span id={`${id}-label`} className="workspace-picker-label">Workspace</span>
    <button ref={trigger} type="button" className="workspace-picker-trigger" disabled={disabled}
      aria-labelledby={`${id}-label ${id}-value`} aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? `${id}-panel` : undefined} title={selected.data.name}
      onClick={() => { setQuery(""); setExpanded(previous => !previous); }}
      onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); setQuery(""); setExpanded(true); } }}>
      <WorkspaceIcon zone={selected} />
      <strong id={`${id}-value`}>{selected.data.name}</strong>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={panel} id={`${id}-panel`} className="workspace-picker-panel"
      role="dialog" aria-labelledby={`${id}-heading`} aria-describedby={`${id}-help`} onKeyDown={navigate}>
      <header><strong id={`${id}-heading`}>Launch in workspace</strong>
        <button type="button" aria-label="Close workspace picker" onClick={() => close(true)}><X size={16} aria-hidden="true" /></button>
      </header>
      <p id={`${id}-help`}>Your leader and its output will appear on this canvas.</p>
      {creating ? <form className="workspace-picker-create" onSubmit={event => {
        event.preventDefault(); event.stopPropagation();
        const trimmed = name.trim().slice(0, 48);
        if (!trimmed || !onCreate) return;
        onChange(onCreate(trimmed));
        close(true);
      }}>
        <label htmlFor={`${id}-name`}>Workspace name</label>
        <input id={`${id}-name`} autoFocus required maxLength={48} value={name}
          placeholder="e.g. Release prep" onChange={event => setName(event.target.value)} />
        <div className="workspace-picker-create-actions">
          <button type="button" onClick={() => { setCreating(false); requestAnimationFrame(() => search.current?.focus()); }}>Cancel</button>
          <button type="submit" disabled={!name.trim()}>Create workspace</button>
        </div>
      </form> : <><label className="workspace-picker-search"><Search size={15} aria-hidden="true" />
        <input ref={search} type="search" aria-label="Find workspace" placeholder="Find a workspace…" value={query}
          onChange={event => setQuery(event.target.value)} />
      </label>
      <div className="workspace-picker-choices" role="group" aria-label="Workspaces">
        {matches.map(workspace => {
          const content = workspace.data.leaderIds.flatMap(leaderId => leaders.get(leaderId) ? [leaders.get(leaderId)!] : []);
          const count = workspace.data.nodeIds?.length ?? 0;
          const summary = content.length ? zoneSummary(content) : count ? `${count} node${count === 1 ? "" : "s"}` : "Empty workspace";
          return <button key={workspace.id} type="button" data-workspace-choice aria-pressed={workspace.id === selected.id}
            aria-label={`Choose ${workspace.data.name}`} aria-describedby={`${id}-summary-${workspace.id}`}
            onClick={() => { onChange(workspace.id); close(true); }}>
            <span className="workspace-picker-icon"><WorkspaceIcon zone={workspace} size={18} /></span>
            <span className="workspace-picker-copy"><strong>{workspace.data.name}</strong>
              <small id={`${id}-summary-${workspace.id}`}>{summary}{workspace.id === currentId && " · Current canvas"}</small>
            </span>
            {workspace.id === selected.id && <Check size={16} aria-hidden="true" />}
          </button>;
        })}
        {!matches.length && <div className="workspace-picker-empty" role="status"><strong>No workspaces found</strong>
          <p>Try another name.</p><button type="button" onClick={() => { setQuery(""); search.current?.focus(); }}>Clear search</button>
        </div>}
      </div>
      <footer>{onCreate ? <button type="button" className="workspace-picker-create-trigger" data-workspace-choice
        onClick={() => { setName(query.trim().slice(0, 48)); setCreating(true); }}>
        <Plus size={16} aria-hidden="true" /> Create workspace
      </button> : "Manage workspaces from Canvas."}</footer></>}
    </div>, document.body)}
  </div>;
}
