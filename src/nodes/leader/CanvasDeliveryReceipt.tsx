import "./canvas-delivery.css";
import { createContext, useContext } from "react";

export interface DeliveryReceipt {
  workItemId?: string;
  state: "sending" | "queued" | "accepted" | "failed" | "unconfirmed";
  text: string;
  reason?: string;
  requestId?: string;
  sessionKey?: string;
}
export const CanvasDeliveryContext = createContext<{
  receipts: Record<string, DeliveryReceipt>;
  retry: (id: string) => void;
} | null>(null);

export function CanvasDeliveryReceipt({ messageId }: { messageId: string }) {
  const delivery = useContext(CanvasDeliveryContext);
  const receipt = delivery?.receipts[messageId];
  if (!receipt) return null;
  const label = { sending: "Sending…", queued: "Queued for leader",
    accepted: "Accepted by server", failed: "Not sent", unconfirmed: "Not confirmed" }[receipt.state];
  return <span className="canvas-delivery-receipt" role="status" title={receipt.reason}>
    {label}{receipt.reason ? ` · ${receipt.reason}` : ""}
    {receipt.state === "failed" && <button type="button"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={() => delivery?.retry(messageId)}>Retry</button>}
    {receipt.state === "unconfirmed" && " · Waiting for confirmation; do not resend."}
  </span>;
}
