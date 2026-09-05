import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FolderInput, Plus, X, Undo2, Globe, Check, ChevronDown, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { ViewportOverlay } from "./components/ViewportOverlay.tsx";
import { GLOBAL_WORKSPACE_ID, visibleZoneNodes, zoneSummary, type CanvasZone } from "./canvas-zones.ts";
import { SkillIcon } from "./components/SkillIcon.tsx";
import { SkillIconPicker } from "./components/SkillIconPicker.tsx";
import type { CanvasNode, CanvasTransform } from "./types.ts";
import type { CanvasZonesController } from "./use-canvas-zones.ts";
import "./canvas-zones.css";

function WorkspaceIcon({ zone, size = 16 }: { zone: CanvasZone; size?: number }) {
  if (zone.id === GLOBAL_WORKSPACE_ID) return <Globe size={size} />;
  return <SkillIcon skill={{ icon: zone.data.icon ?? "minions:folder", category: "general" }} size={size} />;
}

function ZoneDialog({ controller: c }: { controller: CanvasZonesController }) {
  const ref = useRef<HTMLDialogElement>(null);
  const dialog = c.dialog!;
  const deleteZone = dialog.kind === "delete" ? c.zones.find(zone => zone.id === dialog.zoneId) : undefined;
  const [value, setValue] = useState(dialog.kind === "name" ? c.zones.find(z => z.id === dialog.zoneId)?.data.name ?? "" : "");
  const [query, setQuery] = useState("");
  const [icon, setIcon] = useState(dialog.kind !== "choose" ? c.zones.find(zone => zone.id === dialog.zoneId)?.data.icon ?? "minions:folder" : "minions:folder");
  const iconPicker = <SkillIconPicker value={icon} onChange={setIcon} category="general" accentColor="var(--accent)"
    description="Identify this workspace in the switcher and destination lists." allowCustomBadge={false} />;
  useLayoutEffect(() => {
    const element = ref.current!;
    element.showModal();
    const position = () => {
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
      element.style.maxHeight = `${Math.max(80, height - 24)}px`;
      element.style.width = `${Math.min(dialog.kind === "icon" ? 440 : 380, width - 24)}px`;
      const box = element.getBoundingClientRect();
      const anchor = dialog.trigger?.isConnected ? dialog.trigger.getBoundingClientRect() : dialog.anchor;
      const x = anchor ? (anchor.left - box.width - 12 >= left + 12 ? anchor.left - box.width - 12 : anchor.right - box.width) : left + (width - box.width) / 2;
      const y = anchor?.top ?? top + (height - box.height) / 2;
      element.style.left = `${Math.max(left + 12, Math.min(x, left + width - box.width - 12))}px`;
      element.style.top = `${Math.max(top + 12, Math.min(y, top + height - box.height - 12))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(element);
    window.addEventListener("resize", position);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
      element.close();
      // Restore focus after React has finished updating the destination controls.
      queueMicrotask(() => {
        if (document.querySelector('.canvas-zone-dialog[open]')) return;
        const previous = dialog.trigger?.isConnected ? dialog.trigger : document.querySelector<HTMLElement>('.canvas-workspace-toggle');
        previous?.focus({ preventScroll: true });
      });
    };
  }, []);
  return createPortal(<dialog className="canvas-zone-dialog" ref={ref} aria-labelledby="zone-dialog-title"
    onCancel={c.dismissDialog} onMouseDown={e => e.stopPropagation()}>
    <h2 id="zone-dialog-title">{dialog.kind === "icon" ? "Workspace icon" : dialog.kind === "choose" ? "Move to workspace" : dialog.kind === "delete" ? `Delete ${deleteZone?.data.name ?? "workspace"}?` : dialog.zoneId ? "Rename workspace" : "Create workspace"}</h2>
    {dialog.kind === "icon" ? <>
      {iconPicker}
      <div className="canvas-zone-actions"><button type="button" onClick={c.dismissDialog}>Cancel</button>
        <button type="button" onClick={() => setIcon("minions:folder")}>Reset to default</button>
        <button type="button" className="zone-primary" onClick={() => c.saveIcon(icon)}>Save icon</button></div>
    </> : dialog.kind === "delete" ? <>
      <p>{dialog.ids.length ? <>This workspace contains {dialog.ids.length} node{dialog.ids.length === 1 ? "" : "s"}. Move its content to Global, or delete the workspace and everything in it.</> : "This workspace is empty."}</p>
      <div className="canvas-zone-actions">
        <button type="button" onClick={c.dismissDialog}>Cancel</button>
        {dialog.ids.length > 0 && <button type="button" onClick={() => c.remove(dialog.zoneId)}>Delete and move to Global</button>}
        <button type="button" className="zone-danger" onClick={() => c.deleteAll(dialog.zoneId)}>{dialog.ids.length ? "Delete all" : "Delete workspace"}</button>
      </div>
    </> : dialog.kind === "choose" ? <>
      <p>Move {dialog.ids.length} node{dialog.ids.length === 1 ? "" : "s"} to another workspace. Work continues.</p>
      <input autoFocus aria-label="Find destination workspace" value={query} onChange={e => setQuery(e.target.value)} placeholder="Find a workspace…" />
      <div className="canvas-zone-choices">{c.zones.filter(zone => zone.data.name.toLowerCase().includes(query.toLowerCase())).map(zone => <button key={zone.id}
        disabled={dialog.ids.every(id => (c.membership.get(id)?.id ?? GLOBAL_WORKSPACE_ID) === zone.id)} onClick={() => c.park(dialog.ids, zone.id)}>
        <WorkspaceIcon zone={zone} /> {zone.data.name}</button>)}
        <button onClick={() => c.name(dialog.ids)}><Plus size={16} /> Create workspace</button>
      </div><button onClick={c.dismissDialog}>Cancel</button>
    </> : <form onSubmit={e => { e.preventDefault(); c.saveName(value, icon); }}>
      <label htmlFor="canvas-zone-name">Workspace name</label>
      <input id="canvas-zone-name" autoFocus maxLength={48} required value={value} onChange={e => setValue(e.target.value)} placeholder="e.g. Release prep" />
      {!dialog.zoneId && <details className="canvas-workspace-icon-disclosure"><summary><SkillIcon skill={{ icon, category: "general" }} /> Choose workspace icon</summary>{iconPicker}</details>}
      <div className="canvas-zone-actions"><button type="button" onClick={c.dismissDialog}>Cancel</button>
        <button className="zone-primary" disabled={!value.trim()}>Save workspace</button></div>
    </form>}
  </dialog>, document.body);
}

export function CanvasZones({ controller: c, nodes, selectedIds, topOffset = 0, socketConnected = false }: {
  controller: CanvasZonesController; nodes: CanvasNode[]; selectedIds: Set<string>; transform: CanvasTransform; topOffset?: number; socketConnected?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const rail = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const open = expanded || c.dragCount > 0;
  const close = () => { setExpanded(false); setSettingsId(null); setQuery(""); };
  useEffect(() => {
    if (!expanded || c.dialog) return;
    const dismiss = (event: PointerEvent) => {
      if (!rail.current?.contains(event.target as Node)) {
        setExpanded(false); setSettingsId(null); setQuery("");
      }
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [expanded, c.dialog]);
  useEffect(() => {
    if (expanded) panel.current?.querySelector<HTMLElement>('input, [aria-current="true"]')?.focus();
  }, [expanded]);
  useEffect(() => {
    setQuery("");
    setSettingsId(null);
    const chip = [...(rail.current?.querySelectorAll<HTMLElement>('[data-zone-target]') ?? [])]
      .find(element => element.dataset["zoneTarget"] === c.activeId);
    chip?.scrollIntoView?.({ block: "nearest" });
  }, [c.activeId]);
  const top = topOffset + 12;
  const connectionStatus = <span id="canvas-connection-status" className="canvas-connection-status" data-connected={socketConnected} role="status">
    <span className="canvas-connection-dot" aria-hidden="true" />{socketConnected ? "Connected" : "Disconnected"}
  </span>;
  const active = c.zones.find(zone => zone.id === c.activeId)!;
  const selected = c.visibleNodes.filter(n => selectedIds.has(n.id));
  // Global and the current destination stay reachable while filtering.
  const matches = (name: string) => name.toLowerCase().includes(query.trim().toLowerCase());
  const shown = c.zones.filter(z => z.id === GLOBAL_WORKSPACE_ID || z.id === c.activeId || c.dragCount || matches(z.data.name));
  return <>
    <ViewportOverlay>
      <aside ref={rail} className="canvas-zones-rail" style={{ top, maxHeight: `calc(100dvh - ${top + 88}px)` }} aria-label="Canvas workspaces" data-expanded={open} data-dock-pill="zones"
        onMouseDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}
        onKeyDown={e => {
          if (e.key === "Escape" && !c.dialog && !c.dragCount) {
            e.preventDefault(); e.stopPropagation();
            if (settingsId) {
              const settingsTrigger = [...(rail.current?.querySelectorAll<HTMLButtonElement>('[data-workspace-settings]') ?? [])]
                .find(element => element.dataset["workspaceSettings"] === settingsId);
              settingsTrigger?.focus(); setSettingsId(null);
            }
            else { close(); trigger.current?.focus(); }
          }
        }} onBlur={e => {
          if (!c.dialog && e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) close();
        }}>
        <button ref={trigger} className="canvas-workspace-toggle" title={active.data.name} aria-label={`Workspaces · ${active.data.name}`} aria-describedby="canvas-connection-status" aria-expanded={open} aria-controls="canvas-workspace-panel"
          onClick={() => { if (expanded) close(); else setExpanded(true); }}>
          <WorkspaceIcon zone={active} />
          <span><strong>{active.data.name}</strong>{connectionStatus}</span><ChevronDown size={14} aria-hidden="true" />
        </button>
        {open && <div ref={panel} id="canvas-workspace-panel" className="canvas-workspace-panel" role="region" aria-label="Choose workspace">
        <div className="canvas-zone-heading"><strong>{c.dragCount ? "Move to workspace" : "Workspaces"}</strong><span>{c.zones.length}</span></div>
        {c.dragCount > 0 ? <p className="canvas-zone-help">Drop {c.dragCount} node{c.dragCount === 1 ? "" : "s"} on a destination below.</p>
          : c.zones.length > 3 && <input aria-label="Find workspace" value={query} onChange={e => { setQuery(e.target.value); setSettingsId(null); }} placeholder="Find a workspace…" />}
        <div className="canvas-zone-targets" id="canvas-zone-targets">{shown.map(zone => {
          const content = visibleZoneNodes(nodes, zone.id);
          const leaders = content.filter(n => n.type === "leader");
          return <div key={zone.id} className="canvas-workspace-row" data-active={c.activeId === zone.id}>
            <div className="canvas-workspace-destination">
            <button className="canvas-zone-chip" data-zone-target={zone.id} data-target={c.dragTarget === zone.id}
            title={zone.data.name} aria-current={c.activeId === zone.id ? "true" : undefined} aria-label={`Switch to ${zone.data.name}`} onClick={() => { c.viewZone(zone.id); close(); trigger.current?.focus(); }}>
            <span><WorkspaceIcon zone={zone} size={14} /><strong>{zone.data.name}</strong>
              {c.activeId === zone.id && <Check size={14} aria-label="Active workspace" />}</span>
            <small>{c.dragTarget === zone.id ? <span className="canvas-zone-drop-cue"><FolderInput size={13} />Release to move {c.dragCount} nodes</span>
              : leaders.length ? zoneSummary(leaders) : content.length ? `${content.length} node${content.length === 1 ? "" : "s"}` : "Empty workspace"}</small>
          </button>
          {!c.dragCount && zone.id !== GLOBAL_WORKSPACE_ID && <button className="canvas-workspace-settings" data-workspace-settings={zone.id}
            aria-label={`Settings for ${zone.data.name}`} aria-expanded={settingsId === zone.id} aria-controls={`workspace-settings-${zone.id}`}
            onClick={() => setSettingsId(value => value === zone.id ? null : zone.id)}><MoreHorizontal size={16} /></button>}
          </div>
          {!c.dragCount && settingsId === zone.id && <div className="canvas-workspace-actions" id={`workspace-settings-${zone.id}`} role="group" aria-label={`${zone.data.name} settings`}>
            <button onClick={e => c.name([], zone.id, e.currentTarget)}><Pencil size={14} /> Rename workspace</button>
            <button onClick={e => c.editIcon(zone.id, e.currentTarget)}><WorkspaceIcon zone={zone} size={14} /> Change icon</button>
            <button className="zone-danger" onClick={e => c.requestDelete(zone.id, e.currentTarget)}><Trash2 size={14} /> Delete workspace…</button>
          </div>}
          </div>;
        })}</div>
        {!c.dragCount && query.trim() && !c.zones.some(zone => matches(zone.data.name)) && <p className="canvas-zone-help" role="status">No matches for “{query.trim()}”. Current and Global stay available.</p>}
        <div className="canvas-workspace-footer">
        <button data-zone-target="new" data-target={c.dragTarget === "new"} className="canvas-zone-new" onClick={e => c.name([], undefined, e.currentTarget)}>
          <Plus size={14} /> {c.dragCount ? "Drop to create workspace" : "New workspace"}</button>
        {!c.dragCount && selected.length > 0 && <div className="canvas-workspace-selection"><span>{selected.length} selected in {active.data.name}</span><button onClick={() => c.choose()}><FolderInput size={14} /> Move selected to workspace…</button></div>}
        {!c.dragCount && <small className="canvas-zone-help">Each workspace has its own canvas. Work keeps running when you switch.</small>}
        </div>
        </div>}
      </aside>
      {c.receipt && <div className="canvas-zone-receipt" role="status" onMouseDown={e => e.stopPropagation()}>
        <span title={c.receipt}>{c.receipt}</span>{c.receiptZone && c.zones.some(z => z.id === c.receiptZone) && <button onClick={() => c.viewZone(c.receiptZone!)}>Switch workspace</button>}
        {c.undoAvailable && <button onClick={c.undo}><Undo2 size={14} /> Undo</button>}
        <button aria-label="Dismiss workspace notification" onClick={c.dismissReceipt}><X size={14} /></button>
      </div>}
    </ViewportOverlay>
    {c.dialog && <ZoneDialog key={c.dialog.kind + (c.dialog.kind !== "choose" ? c.dialog.zoneId ?? "new" : "")} controller={c} />}
  </>;
}
