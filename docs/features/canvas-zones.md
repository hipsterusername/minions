# Canvas workspaces

Canvas workspaces are always available. Use the **Workspaces · name** button to create and switch between canvases.

- **Global** is the permanent main canvas. It always appears first and cannot be renamed or deleted.
- Select a workspace to switch to its canvas and fit its content into view. Switching preserves every node’s position, size, draft, and live session. Re-selecting the current workspace fits it again. There is no return-to-canvas or retrieval step.
- **New workspace** creates and switches to an empty canvas. Nodes created, pasted, or dropped there belong to that workspace. Minions and dashboards follow their owning leader, even when they arrive while a different workspace is active.
- Select content and choose **Move selected to workspace…**, right-click a node, or drag content onto a workspace. Transfers keep the current canvas active and offer a **Switch workspace** receipt. Leaders bring their owned output; context groups bring their contained content. Global is a transfer destination too.
- **Workspace settings** offers rename and deletion for the active non-Global workspace. Deletion offers moving all content to Global or deleting the workspace and its content through the existing node/session cleanup. Transfers, renames, creation, and deletion that preserves content offer Undo without replacing live session data.
- Fit, layout, minimap, marquee selection, node creation placement, and visible edges use the active canvas. Search and attention navigation switch to the destination node’s workspace. Cross-workspace connections retain their graph/context routing and label the remote workspace.
- On narrow windows, the compact **Workspaces · name** button expands the switcher. Global and the current workspace stay reachable while filtering the list.

Existing saved Zones become Workspaces automatically. The non-spatial `canvas-zone` metadata records retain `version`, `name`, and legacy `leaderIds`, adding `nodeIds` for general canvas content. A reserved Global metadata record stores `activeWorkspaceId` through the existing atomic canvas autosave. Global is also synthesized for old or empty canvases. Missing workspace references fall back to Global.
