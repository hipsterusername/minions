import type { ReactNode } from "react";
import { Undo2, X } from "lucide-react";
import "../canvas-zones.css";

export function UndoNotification({ message, onUndo, undoDisabled = false, onDismiss, dismissLabel, className = "", children }: {
  message: string;
  onUndo?: (() => void) | undefined;
  undoDisabled?: boolean;
  onDismiss: () => void;
  dismissLabel: string;
  className?: string;
  children?: ReactNode;
}) {
  return <div className={`canvas-zone-receipt ${className}`} role="status" onMouseDown={event => event.stopPropagation()}>
    <span title={message}>{message}</span>
    {children}
    {onUndo && <button type="button" disabled={undoDisabled} onClick={onUndo}><Undo2 size={14} /> Undo</button>}
    <button type="button" aria-label={dismissLabel} onClick={onDismiss}><X size={14} /></button>
  </div>;
}
