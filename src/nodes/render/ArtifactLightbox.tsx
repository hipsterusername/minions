import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./dashboard-polish.css";

/** Native modal behavior keeps focus (including embedded documents) inside the
 * lightbox and makes the rest of the page inert while it is open. */
export function ArtifactLightbox({ label, onClose, children }: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const trigger = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.showModal();
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      dialog?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  return createPortal(
    <dialog ref={dialogRef} className="dashboard-lightbox" aria-label={label} aria-modal="true"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <button ref={closeRef} type="button" className="dashboard-lightbox-close" aria-label={`Close ${label}`} onClick={onClose}>
        Close <span aria-hidden="true">×</span>
      </button>
      {children}
    </dialog>, document.body,
  );
}
