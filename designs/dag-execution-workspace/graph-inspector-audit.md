# Graph Inspector visual audit

Audit date: 2026-08-17

Reference: `index.html` and `ux-contract.md` in this folder. The production surface is `src/task-graph/GraphInspector.tsx` with `src/task-graph/task-graph.css`.

## Repair plan and disposition

| Priority | Issue | User impact | Resolution |
|---|---|---|---|
| P0 | Mobile Leader sessions had no graph entry point. | Operators could not inspect canonical graph topology away from Canvas. | Added a Graph tab that subscribes to the WorkItem topic through `useTaskGraphView` and opens the same revision-fenced inspector. |
| P0 | Narrow plan and detail drawers could be open together. | Drawers overlapped and obscured the graph, especially at phone widths. | Narrow disclosure is mutually exclusive; selecting a node closes the plan drawer before opening details. |
| P1 | Collapsing a rail removed it completely instead of leaving the specified 42px edge affordance. | The graph gained space, but the hidden content became hard to rediscover. | Added persistent keyboard-focusable Plan and Details edge tabs on desktop, tablet, and mobile. |
| P1 | Shipped rail widths drifted from the prototype contract (`220 / graph / 360`). | Details dominated the workspace while the authored plan was cramped. | Restored `246 / minmax(440, 1fr) / 304`, with the documented compact widths below 1100px. |
| P1 | The mobile media query overwrote `100dvh` with `100vh`. | Browser chrome and virtual viewport changes could crop the inspector. | Kept the inspector at `100dvh` and removed the late `100vh` override. |
| P1 | Mobile chrome ignored display cutouts and home-indicator insets. | Controls could sit too close to unsafe screen edges. | Added safe-area-aware header, mission, drawer, and iteration-bar padding. |
| P1 | Mobile tab, filter, and close targets were undersized and labels were difficult to read. | Touch accuracy and scanning suffered. | Raised primary targets to 44px, filter targets to 36px, and increased narrow control/status type sizes. |
| P1 | Escape closed the whole inspector while a narrow rail was open. | Keyboard users lost their inspector context instead of dismissing one layer. | Escape now closes the active narrow rail first; the next Escape closes the inspector. |
| P2 | The plan drawer lacked a local close affordance. | On mobile, the header toggle was remote from the drawer content. | Added an in-rail close button at narrow widths and a backdrop that dismisses either drawer. |
| P2 | Four Leader-session views did not fit the existing three-column mobile tab grid. | Adding Graph would squeeze or overflow navigation. | The tab grid switches to four equal columns only when a graph projection exists. |

## Verification strategy

- Component behavior: Graph Inspector, task-graph integration, and mobile session tests.
- Responsive contract: narrow initialization, mutually exclusive rails, Escape layering, and mobile graph entry tests.
- Static visual reference: the self-contained `index.html` can be opened directly or served from `designs/`.
- Runtime preview: use the real task-graph E2E harness when local Chromium/socket permissions are available.

The implementation deliberately does not change graph topology ownership, delta folding, revision recovery, action fences, or server control semantics.
