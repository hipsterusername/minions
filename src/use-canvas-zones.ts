import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, RefObject } from "react";
import type { CanvasAction, CanvasNode, CanvasTransform, Position } from "./types.ts";
import { activeWorkspaceId, createZone, GLOBAL_WORKSPACE_ID, isWorkspaceIcon, moveToZone, readWorkspaces, readZones, visibleZoneNodes, workspaceTransferIds, zoneMembership } from "./canvas-zones.ts";
import { focusTransformOnRects } from "./canvas-utils.ts";
import { generateId } from "./canvas-state.ts";

type Move = { id: string; position: Position };
type DialogState = ({ kind: "choose"; ids: string[] } | { kind: "name"; ids: string[]; zoneId?: string } | { kind: "icon"; zoneId: string } | { kind: "delete"; ids: string[]; zoneId: string }) & { trigger: HTMLElement | null; anchor: DOMRect | null };
function dialogOrigin(trigger?: HTMLElement | null) {
  const element = trigger ?? (document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement : document.querySelector<HTMLElement>('.canvas-workspace-toggle'));
  return { trigger: element, anchor: element?.getBoundingClientRect() ?? null };
}
interface Options {
  nodes: CanvasNode[]; dispatch: Dispatch<CanvasAction>; selectedIds: Set<string>;
  setSelectedIds: Dispatch<React.SetStateAction<Set<string>>>;
  transform: CanvasTransform; containerRef: RefObject<HTMLDivElement | null>;
  reveal: (transform: CanvasTransform, ids: string[]) => void;
  removeNodes?: ((nodes: CanvasNode[]) => void) | undefined;
  topOffset?: number;
}

export function useCanvasZones(options: Options) {
  const zones = useMemo(() => readWorkspaces(options.nodes), [options.nodes]);
  const activeId = activeWorkspaceId(options.nodes);
  const membership = useMemo(() => zoneMembership(options.nodes), [options.nodes]);
  const visibleNodes = useMemo(() => visibleZoneNodes(options.nodes, activeId), [options.nodes, activeId]);
  const hiddenMembership = useMemo(() => {
    const visible = new Set(visibleNodes.map(n => n.id));
    return new Map(options.nodes.filter(n => n.type !== "canvas-zone" && !visible.has(n.id))
      .map(n => [n.id, membership.get(n.id) ?? zones[0]!]));
  }, [options.nodes, visibleNodes, membership, zones]);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  const [dragCount, setDragCount] = useState(0);
  const [notification, setNotification] = useState<{ message: string } | null>(null);
  const receipt = notification?.message ?? "";
  const [receiptZone, setReceiptZone] = useState<string | null>(null);
  const [undoAvailable, setUndoAvailable] = useState(false);
  const undoRef = useRef<{ zones: CanvasNode[]; moves: Move[]; activeId: string; nodeIds: Set<string> } | null>(null);
  const drag = useRef<{ ids: string[]; moves: Move[] } | null>(null);
  const latest = useRef({ ...options, zones, membership, activeId });
  latest.current = { ...options, zones, membership, activeId };

  const dismissReceipt = useCallback(() => {
    setNotification(null);
    setReceiptZone(null);
  }, []);
  useEffect(() => {
    if (!notification) return;
    const timer = window.setTimeout(dismissReceipt, 6_000);
    return () => window.clearTimeout(timer);
  }, [notification, dismissReceipt]);

  const fitWorkspace = useCallback((id: string, selected: string[] = []) => {
    const { nodes, containerRef, reveal, topOffset = 0 } = latest.current;
    const box = containerRef.current?.getBoundingClientRect();
    const width = box?.width || containerRef.current?.clientWidth || 800;
    const height = box?.height || containerRef.current?.clientHeight || 600;
    const top = Math.max(24, topOffset + 64 - (box?.top ?? 0));
    const viewport = { width: Math.max(120, width - 48), height: Math.max(120, height - top - 80) };
    const content = visibleZoneNodes(nodes, id);
    const target = focusTransformOnRects(content.map(n => ({ ...n.position, ...n.size })), viewport, { padding: 32, maxScale: 1 });
    reveal(target ? { ...target, y: target.y + top } : { x: 32, y: top + 32, scale: 1 }, selected);
  }, []);
  const viewZone = useCallback((id: string) => {
    if (!latest.current.zones.some(z => z.id === id)) return;
    latest.current.setSelectedIds(new Set());
    latest.current.dispatch({ type: "SET_ACTIVE_WORKSPACE", id });
    if (id === latest.current.activeId) fitWorkspace(id);
  }, [fitWorkspace]);
  const previousActive = useRef(activeId === GLOBAL_WORKSPACE_ID ? activeId : "");
  useEffect(() => {
    if (previousActive.current !== activeId) fitWorkspace(activeId);
    previousActive.current = activeId;
  }, [activeId, fitWorkspace]);

  const commit = useCallback((nextZones: CanvasNode[], moves: Move[], message: string, undoMoves?: Move[]) => {
    const { nodes, dispatch, setSelectedIds, activeId } = latest.current;
    const moved = new Set(moves.map(m => m.id));
    undoRef.current = { zones: readZones(nodes), activeId, nodeIds: new Set(nodes.map(n => n.id)), moves: undoMoves ?? nodes.filter(n => moved.has(n.id)).map(n => ({ id: n.id, position: n.position })) };
    dispatch({ type: "UPDATE_ZONES", zones: nextZones, moves });
    setSelectedIds(new Set()); setUndoAvailable(true); setNotification({ message }); setReceiptZone(null);
  }, []);
  const undo = useCallback(() => {
    if (!undoRef.current) return;
    const { zones, moves, activeId } = undoRef.current;
    // Preserve membership of content created since the operation being undone.
    const current = readZones(latest.current.nodes);
    const existing = undoRef.current.nodeIds;
    const restored = zones.map(zone => {
      const data = zone.data as { nodeIds?: string[] };
      const added = current.find(z => z.id === zone.id)?.data.nodeIds?.filter(id => !existing.has(id)) ?? [];
      return { ...zone, data: { ...data, nodeIds: [...(data.nodeIds ?? []), ...added] } };
    });
    latest.current.dispatch({ type: "UPDATE_ZONES", zones: restored, moves });
    latest.current.dispatch({ type: "SET_ACTIVE_WORKSPACE", id: activeId });
    undoRef.current = null; setUndoAvailable(false); setNotification({ message: "Workspace change undone." }); setReceiptZone(null);
  }, []);
  const park = useCallback((ids: string[], zoneId: string, moves: Move[] = []) => {
    const { zones, nodes } = latest.current;
    const zone = zones.find(z => z.id === zoneId);
    if (!zone) return;
    const members = workspaceTransferIds(visibleZoneNodes(nodes, latest.current.activeId), ids);
    if (!members.length) return;
    commit(moveToZone(readZones(nodes), members, zoneId), moves, `Content moved to ${zone.data.name}.`, moves.length ? moves : undefined);
    setDialog(null); setReceiptZone(zoneId);
  }, [commit]);
  const choose = useCallback((nodeId?: string) => {
    const { selectedIds, nodes, activeId } = latest.current;
    const selection = nodeId && !selectedIds.has(nodeId) ? [nodeId] : [...selectedIds];
    const ids = workspaceTransferIds(visibleZoneNodes(nodes, activeId), selection);
    if (!ids.length) return;
    setDialog({ kind: "choose", ids, ...dialogOrigin() });
  }, []);
  const name = useCallback((ids: string[] = [], zoneId?: string, trigger?: HTMLElement) => {
    if (zoneId === GLOBAL_WORKSPACE_ID) return;
    const origin = dialog && !trigger ? { trigger: dialog.trigger, anchor: dialog.anchor } : dialogOrigin(trigger);
    setDialog(zoneId ? { kind: "name", ids, zoneId, ...origin } : { kind: "name", ids, ...origin });
  }, [dialog]);
  const editIcon = useCallback((zoneId: string, trigger?: HTMLElement) => {
    if (zoneId === GLOBAL_WORKSPACE_ID || !latest.current.zones.some(zone => zone.id === zoneId)) return;
    setDialog({ kind: "icon", zoneId, ...dialogOrigin(trigger) });
  }, []);
  const saveIcon = useCallback((icon: string) => {
    if (dialog?.kind !== "icon" || !isWorkspaceIcon(icon)) return;
    commit(readZones(latest.current.nodes).map(zone => zone.id === dialog.zoneId ? { ...zone, data: { ...zone.data, icon } } : zone), [], "Workspace icon updated.");
    setDialog(null);
  }, [dialog, commit]);
  const saveName = useCallback((value: string, icon?: string) => {
    const trimmed = value.trim().slice(0, 48);
    if (!trimmed || dialog?.kind !== "name" || dialog.zoneId === GLOBAL_WORKSPACE_ID) return;
    const zones = readZones(latest.current.nodes);
    if (dialog.zoneId) {
      commit(zones.map(z => z.id === dialog.zoneId ? { ...z, data: { ...z.data, name: trimmed } } : z), [], "Workspace renamed.");
    } else {
      const zone = createZone(`workspace-${generateId()}`, trimmed);
      if (isWorkspaceIcon(icon)) zone.data.icon = icon;
      commit(moveToZone([...zones, zone], dialog.ids, zone.id), [], `${trimmed} created.`);
      latest.current.dispatch({ type: "SET_ACTIVE_WORKSPACE", id: zone.id });
    }
    setDialog(null);
  }, [dialog, commit]);
  const inspect = useCallback((id: string) => {
    const { nodes, membership, activeId } = latest.current;
    if (!nodes.some(n => n.id === id && n.type !== "canvas-zone")) return false;
    const workspace = membership.get(id)?.id ?? GLOBAL_WORKSPACE_ID;
    if (workspace === activeId) return false;
    viewZone(workspace); return true;
  }, [viewZone]);
  const requestDelete = useCallback((id: string, trigger?: HTMLElement) => {
    if (id === GLOBAL_WORKSPACE_ID) return;
    const zone = latest.current.zones.find(z => z.id === id);
    if (!zone) return;
    const ids = visibleZoneNodes(latest.current.nodes, id).map(n => n.id);
    setDialog({ kind: "delete", zoneId: id, ids, ...dialogOrigin(trigger) });
  }, []);
  const remove = useCallback((id: string) => {
    if (id === GLOBAL_WORKSPACE_ID || !latest.current.zones.some(z => z.id === id)) return;
    commit(readZones(latest.current.nodes).filter(z => z.id !== id), [], "Workspace deleted. Its content moved to Global.");
    latest.current.dispatch({ type: "SET_ACTIVE_WORKSPACE", id: GLOBAL_WORKSPACE_ID });
    setDialog(null);
  }, [commit]);
  const deleteAll = useCallback((id: string) => {
    if (id === GLOBAL_WORKSPACE_ID || !latest.current.zones.some(z => z.id === id)) return;
    const { nodes, dispatch, removeNodes } = latest.current;
    const deleted = [...visibleZoneNodes(nodes, id), ...nodes.filter(n => n.id === id)];
    if (removeNodes) removeNodes(deleted);
    else dispatch({ type: "REMOVE_NODES", ids: deleted.map(n => n.id) });
    dispatch({ type: "SET_ACTIVE_WORKSPACE", id: GLOBAL_WORKSPACE_ID });
    undoRef.current = null; setUndoAvailable(false); setDialog(null); setReceiptZone(null);
    setNotification({ message: "Workspace and its content deleted." });
  }, []);
  const beginDrag = useCallback((nodeId: string, event?: MouseEvent) => {
    const { nodes, selectedIds, activeId } = latest.current;
    const ids = workspaceTransferIds(visibleZoneNodes(nodes, activeId), selectedIds.has(nodeId) ? [...selectedIds] : [nodeId]);
    drag.current = { ids, moves: nodes.filter(n => ids.includes(n.id)).map(n => ({ id: n.id, position: n.position })) };
    setDragCount(ids.length);
    if (event) setDragTarget(document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-zone-target]")?.dataset["zoneTarget"] ?? null);
  }, []);
  const endDrag = useCallback((_nodeId: string, event?: MouseEvent) => {
    const pending = drag.current; drag.current = null; setDragCount(0); setDragTarget(null);
    if (!pending) return false;
    if (!event || event.type !== "mouseup") {
      latest.current.dispatch({ type: "MOVE_GROUP", moves: pending.moves }); return true;
    }
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-zone-target]")?.dataset["zoneTarget"];
    if (!target) return false;
    if (target === "new") {
      latest.current.dispatch({ type: "MOVE_GROUP", moves: pending.moves }); name(pending.ids);
    } else park(pending.ids, target, pending.moves);
    return true;
  }, [name, park]);
  useEffect(() => {
    const visible = new Set(visibleNodes.map(n => n.id));
    options.setSelectedIds(prev => {
      const next = new Set([...prev].filter(id => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [visibleNodes, options.setSelectedIds]);
  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (drag.current) setDragTarget(document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-zone-target]")?.dataset["zoneTarget"] ?? null);
    };
    window.addEventListener("mousemove", move);
    return () => window.removeEventListener("mousemove", move);
  }, []);
  return { zones, activeId, visibleNodes, membership, hiddenMembership, dialog, dragTarget, dragCount,
    receipt, receiptZone, undoAvailable, undo, viewZone, park, choose, name, saveName, editIcon, saveIcon, inspect, remove, requestDelete, deleteAll,
    beginDrag, endDrag, dismissDialog: () => setDialog(null), dismissReceipt };
}
export type CanvasZonesController = ReturnType<typeof useCanvasZones>;
