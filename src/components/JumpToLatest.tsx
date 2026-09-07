import { ArrowDown } from "lucide-react";
import "./jump-to-latest.css";

export function JumpToLatest({ onClick, hasNewActivity }: { onClick: () => void; hasNewActivity: boolean }) {
  return <div className="chat-latest">
    <button type="button" onClick={onClick}>
      <ArrowDown size={14} aria-hidden="true" />
      {hasNewActivity ? "New activity · Jump to latest" : "Jump to latest"}
    </button>
  </div>;
}
