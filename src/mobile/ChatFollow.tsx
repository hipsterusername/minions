import "./chat-follow.css";

export function ChatFollow({ onResume }: { onResume: () => void }) {
  return <div className="mob-chat-follow"><button type="button" onClick={onResume}>
    New activity <span aria-hidden="true">↓</span>
  </button></div>;
}
