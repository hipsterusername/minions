import { memo } from "react";
import { AddAsNodeButton } from "../../../components/AddAsNodeButton.tsx";
import { CopyButton } from "../../../components/CopyButton.tsx";

/**
 * Floating action chip stuck to the top-right of an assistant message
 * bubble. Provides "Add as node" + "Copy" shortcuts. Rendered when the
 * message is NOT in chunk-selection mode.
 */
export const LeaderMessageActions = memo(function LeaderMessageActions({
  text,
  onAddContentNode,
}: {
  text: string;
  onAddContentNode?: ((content: string) => void) | undefined;
}) {
  return (
    <div
      data-testid="leader-message-actions"
      style={{
        position: "sticky",
        top: 8,
        zIndex: 6,
        height: 0,
        display: "flex",
        justifyContent: "flex-end",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 4,
          pointerEvents: "auto",
        }}
      >
        <AddAsNodeButton
          text={text}
          onAdd={onAddContentNode}
          layout="inline"
        />
        <CopyButton text={text} layout="inline" />
      </div>
    </div>
  );
});
