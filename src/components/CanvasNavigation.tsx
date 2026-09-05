import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Bell, Search, X } from "lucide-react";
import type { CanvasAttentionItem } from "../canvas-attention.ts";
import "./canvas-navigation.css";

interface Props {
  top: number;
  left?: number;
  right?: number;
  canGoBack: boolean;
  onBack: () => void;
  onFind: () => void;
  attention: CanvasAttentionItem[];
  onAttention: (item: CanvasAttentionItem) => void;
  announcement: string;
}

export function CanvasNavigation({ top, left = 16, right = 160, canGoBack, onBack, onFind, attention, onAttention, announcement }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  return (
    <div ref={root} className="canvas-navigation" style={{ top, left, right }} onKeyDown={event => {
      if (event.key === "Escape" && open) {
        event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
      }
    }} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
    }}>
      <nav aria-label="Canvas navigation" className="canvas-navigation__bar">
        {canGoBack && <button type="button" onClick={onBack} title="Restore previous canvas position, zoom and selection">
          <ArrowLeft size={15} aria-hidden="true" /> Back
        </button>}
        <button type="button" onClick={() => { setOpen(false); onFind(); }}>
          <Search size={15} aria-hidden="true" /> Find on canvas <kbd>{/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K"}</kbd>
        </button>
        <button ref={trigger} type="button" aria-expanded={open} aria-controls="canvas-attention-list" onClick={() => setOpen(value => !value)} className={attention.length ? "canvas-navigation__attention" : undefined}>
          <Bell size={15} aria-hidden="true" /> Needs attention <span className="canvas-navigation__count">{attention.length}</span>
        </button>
      </nav>
      {open && <div ref={panel} id="canvas-attention-list" className="canvas-navigation__panel" role="region" aria-label="Work needing attention">
        <div className="canvas-navigation__heading"><strong>Needs attention</strong><button type="button" aria-label="Close attention list" onClick={() => { setOpen(false); trigger.current?.focus(); }}><X size={16} /></button></div>
        {attention.length === 0 ? <p className="canvas-navigation__empty">No work needs your attention.</p> : <ul>
          {attention.map(item => <li key={item.session.workItemId ?? item.session.sessionKey}>
            <button type="button" className="canvas-navigation__destination" onClick={() => { setOpen(false); onAttention(item); }}>
              <strong>{item.title}</strong><span>{item.reason}</span><small>{item.zoneName ? `Open in ${item.zoneName}` : item.nodeId ? "Show on canvas" : "Open in Activity"}</small>
            </button>
          </li>)}
        </ul>}
      </div>}
      <span className="canvas-navigation__sr" role="status" aria-live="polite">{announcement}</span>
    </div>
  );
}
