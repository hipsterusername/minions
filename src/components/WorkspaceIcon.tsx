import { Globe } from "lucide-react";
import { GLOBAL_WORKSPACE_ID, type CanvasZone } from "../canvas-zones.ts";
import { SkillIcon } from "./SkillIcon.tsx";

export function WorkspaceIcon({ zone, size = 16 }: { zone: CanvasZone; size?: number }) {
  if (zone.id === GLOBAL_WORKSPACE_ID) return <Globe size={size} aria-hidden="true" />;
  return <SkillIcon skill={{ icon: zone.data.icon ?? "minions:folder", category: "general" }} size={size} />;
}
