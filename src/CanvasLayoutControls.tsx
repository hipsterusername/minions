import type { ProjectSettings } from "./api.ts";
import { ToggleRow } from "./SettingsControls.tsx";

export function CanvasLayoutControls({ settings, onSettingsChange }: {
  settings: ProjectSettings; onSettingsChange: (settings: ProjectSettings) => void;
}) {
  return <>
    <ToggleRow label="Tidy layout"
      description="Snap to grid, prevent overlaps, and keep dashboards attached to their Leader."
      checked={settings.tidyLayout !== false}
      onChange={checked => onSettingsChange({ ...settings, tidyLayout: checked })} />
    <ToggleRow label="Snap while dragging"
      description="Align nearby top and bottom edges or stack nodes above and below. Drag farther away to release."
      checked={settings.snapWhileDragging !== false}
      onChange={checked => onSettingsChange({ ...settings, snapWhileDragging: checked })} />
  </>;
}
