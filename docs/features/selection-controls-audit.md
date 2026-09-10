# Selection controls audit

Reviewed September 8, 2026. Scope: native select declarations in production `src/**/*.tsx`, their callers, and existing richer selection patterns. Counts refer to declarations, not rendered instances; reusable controls can appear many times. There were 25 declarations before the Activity Workspace change, and 24 remain. A text search also matches a comment in `FormComponent.tsx`; that is excluded.

## Workspace: implemented

The Activity launch destination now uses a searchable workspace picker with the same icon renderer and activity summaries as Canvas. Its trigger displays the workspace name and icon. Choices distinguish the selected launch destination from the current canvas, expose activity or empty-state context, and preserve the existing commit-to-workspace behavior. Choosing a destination does not switch the canvas or launch a leader.

The panel opens outside the scrolling configuration surface, stays within the viewport, and supports search, arrow keys, Home/End, Enter, Escape, outside dismissal, and focus return. Hiding a draft or starting its launch closes the panel. No workspace creation or management actions were added to this flow.

Implementation: [WorkspacePicker](../../src/components/WorkspacePicker.tsx), [shared WorkspaceIcon](../../src/components/WorkspaceIcon.tsx), [Activity integration](../../src/ActivityView.tsx).

## Recommended follow-ups

| Priority | Surface and evidence | Assessment and proposed interaction |
| --- | --- | --- |
| High | Model: [ActivityLaunchForm](../../src/nodes/leader/ActivityLaunchForm.tsx), two selectors in [DialecticNode](../../src/nodes/DialecticNode.tsx), [MobileLeaderRuntimeControls](../../src/mobile/MobileLeaderRuntimeControls.tsx), and exported `ModelSelect` in [SettingsMenu](../../src/SettingsMenu.tsx), consumed by [MobileMinionModelSettings](../../src/mobile/MobileMinionModelSettings.tsx) | Provider grouping exists, but names alone offer little help comparing choices. Desktop already has `ModelSelectionMenu` with provider identity and reasoning controls. Reuse that interaction in launch and dialectic after adapting its inputs; on mobile use a searchable sheet for longer lists while retaining the project-default choice. Preserve unsupported/current model fallbacks and harness restrictions. |
| High | Permissions: [ActivityLaunchForm](../../src/nodes/leader/ActivityLaunchForm.tsx), private `Select` in [SettingsMenu](../../src/SettingsMenu.tsx), two selectors in [SandboxPolicyControls](../../src/nodes/leader/SandboxPolicyControls.tsx) | Permission descriptions are squeezed into option labels in launch; settings exposes short mode labels. Use labeled radio choices with persistent explanations of each mode. Keep filesystem access and approval policy as distinct decisions, including disabled provider capabilities. This is about explaining effects before selection. |
| High | Target lineage: [LineageModal](../../src/LineageModal.tsx) | Options show a truncated ID and target ref, while the surrounding lineage list already knows leader/contribution counts and integration state. Use destination rows carrying that context and mark the current lineage. Keep the existing explicit mapping button and revision guard. |
| Medium | Session switcher: [SessionChatScreen](../../src/mobile/SessionChatScreen.tsx) | A compact symbol opens a title-only native list. Duplicate titles and many sessions make destinations hard to distinguish. Use a labeled sheet with search, session status, role, and selected state. Preserve native selection as a reasonable fallback on small devices. |
| Medium | Orchestration and reasoning: [ActivityLaunchForm](../../src/nodes/leader/ActivityLaunchForm.tsx) | Two orchestration modes deserve visible radio choices explaining when work starts. Reasoning can reuse the existing `ThinkingControls` segmented interaction from [SettingsMenu](../../src/SettingsMenu.tsx), adapting to the supported effort count and available width. Neither needs a large popover. |
| Medium | Activity visibility: [ActivityView](../../src/ActivityView.tsx) | Open / All / Dismissed is a frequent navigation decision; counts are already available. A three-way segmented filter would expose scope and counts without opening a menu. Keep the compact select at narrow widths if labels do not fit. Preserve current filter-reset behavior. |
| Low | Node type: [CommandPalette](../../src/components/CommandPalette.tsx) | The palette already offers richer node navigation, but creation uses a select. An icon-bearing list of node types would improve consistency. The existing select is acceptable for the small list; preserve typed creation text and keyboard behavior if replacing it. |

## Native selects that fit their current role

| Surface | Evaluation |
| --- | --- |
| Category filters in [SkillsBrowser](../../src/SkillsBrowser.tsx) and [SkillIconPicker](../../src/components/SkillIconPicker.tsx) | Keep. They narrow a larger, already visual grid and sit alongside search. Replacing them adds little recognition or context. |
| Variable type and skill category in [SkillEditor](../../src/SkillEditor.tsx) | Keep the compact enums. Improve programmatic labeling: the variable type's sibling `label` is not associated with its select. The skill-category control already has an ID. |
| Transport in [McpServersBrowser](../../src/McpServersBrowser.tsx) | Keep the short technical enum; add an associated label and brief transport help if users need it. The form already changes fields for the selected transport. |
| Skill variable values in [ActivityLaunchForm](../../src/nodes/leader/ActivityLaunchForm.tsx), [SkillVariableInputs](../../src/nodes/leader/skills/SkillVariableInputs.tsx), and [LaunchSkillsPanel](../../src/mobile/LaunchSkillsPanel.tsx) | Keep for author-defined short option lists. A future searchable control should be driven by actual list size; preserve option values, defaults, and disabled/read-only behavior. |
| Generated form selection in [FormComponent](../../src/nodes/render/FormComponent.tsx) | Keep. It already handles required/optional choices, labels, errors, and disabled state. A blanket custom replacement risks generic form accessibility and submission semantics without evidence of a usability problem. |

## Existing patterns to reuse

- [CanvasZones](../../src/CanvasZones.tsx): workspace icons, search, activity summaries, and destination context; the Activity picker now shares its icon renderer and summary function.
- [SessionToolbar](../../src/components/SessionToolbar.tsx): `ModelSelectionMenu`, already used by desktop settings and [MinionModelRoutingSettings](../../src/MinionModelRoutingSettings.tsx).
- [SettingsMenu](../../src/SettingsMenu.tsx): `ThinkingControls` exposes effort choices directly.
- [SkillIconPicker](../../src/components/SkillIconPicker.tsx): searchable visual choices with keyboard navigation, selection preview, and empty-state recovery.

The follow-ups above are evaluated recommendations, not implemented changes. Replace native selection when identity, comparison, consequences, or list length justifies the added interaction. Retain native behavior for straightforward short enums.
