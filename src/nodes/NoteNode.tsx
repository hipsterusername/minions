import { useState } from "react";
import type { NodeRenderProps } from "../types.ts";
import { registerNodeType } from "../node-registry.ts";
import { registerContract, CONTEXT_OUT_PORT } from "../graph.ts";
import type { NodeInterfaceContract } from "../graph.ts";

const NOTE_CONTRACT: NodeInterfaceContract = {
  nodeType: "note",
  label: "Note",
  description: "A sticky note that can provide text context to Leader nodes.",
  ports: [CONTEXT_OUT_PORT],
};
registerContract(NOTE_CONTRACT);

interface NoteData {
  text: string;
  color: string;
}

const COLORS = [
  { bg: "#1a2744", border: "#1e3a5f", label: "Blue" },
  { bg: "#1a3329", border: "#1e4d3d", label: "Green" },
  { bg: "#362014", border: "#4a2c1a", label: "Orange" },
  { bg: "#2d1a3a", border: "#3b1f52", label: "Purple" },
  { bg: "#3a1a2e", border: "#4a1f3a", label: "Pink" },
  { bg: "#1e293b", border: "#334155", label: "Slate" },
];

function NoteNodeRenderer({ node, onUpdateData }: NodeRenderProps) {
  const data = node.data as NoteData;
  const colorDef = COLORS.find((c) => c.bg === data.color) ?? COLORS[0]!;
  const [showColors, setShowColors] = useState(false);
  const [portHover, setPortHover] = useState(false);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: colorDef.bg,
        borderRadius: 8,
        border: `1px solid ${colorDef.border}`,
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* Context port indicator */}
      <div
        onMouseEnter={() => setPortHover(true)}
        onMouseLeave={() => setPortHover(false)}
        title="Drag to connect as context to a Leader"
        style={{
          position: "absolute",
          right: -4,
          top: "50%",
          transform: "translateY(-50%)",
          width: 10,
          height: 10,
          borderRadius: "50%",
          backgroundColor: "#4ade80",
          opacity: portHover ? 1.0 : 0.5,
          boxShadow: portHover
            ? "0 0 8px rgba(74, 222, 128, 0.6)"
            : "none",
          transition: "opacity 0.15s, box-shadow 0.15s",
          zIndex: 10,
          cursor: "crosshair",
        }}
      />
      <div
        style={{
          padding: "8px 12px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: `1px solid ${colorDef.border}`,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 10,
            color: "var(--text-muted)",
            textTransform: "uppercase",
            letterSpacing: 1,
            fontFamily: "var(--font-mono)",
          }}
        >
          Note
          <span
            style={{
              color: "var(--text-muted)",
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              textTransform: "none",
              letterSpacing: 0,
            }}
          >
            {" "}· Context
          </span>
        </span>
        <button
          onClick={() => setShowColors(!showColors)}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            width: 14,
            height: 14,
            borderRadius: "50%",
            backgroundColor: colorDef.border,
          }}
          title="Change color"
        />
      </div>
      {showColors && (
        <div
          style={{
            display: "flex",
            gap: 4,
            padding: "6px 12px",
            borderBottom: `1px solid ${colorDef.border}`,
            flexShrink: 0,
          }}
        >
          {COLORS.map((c) => (
            <button
              key={c.bg}
              onClick={() => {
                onUpdateData({ ...data, color: c.bg });
                setShowColors(false);
              }}
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                width: 18,
                height: 18,
                borderRadius: 4,
                background: c.bg,
                border: `2px solid ${
                  c.bg === data.color ? "var(--accent)" : c.border
                }`,
                cursor: "pointer",
              }}
              title={c.label}
            />
          ))}
        </div>
      )}
      <textarea
        value={data.text}
        onChange={(e) => onUpdateData({ ...data, text: e.target.value })}
        onMouseDown={(e) => e.stopPropagation()}
        placeholder="Write a note..."
        style={{
          flex: 1,
          padding: "10px 12px",
          background: "transparent",
          border: "none",
          color: "var(--text-primary)",
          fontSize: 13,
          fontFamily: "var(--font-sans)",
          resize: "none",
          outline: "none",
          lineHeight: 1.5,
        }}
      />
    </div>
  );
}

registerNodeType({
  type: "note",
  label: "Note",
  defaultSize: { width: 240, height: 180 },
  render: NoteNodeRenderer,
});
