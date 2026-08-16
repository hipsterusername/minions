# DAG execution workspace prototype report

Artifact: `designs/dag-execution-workspace/index.html`

## Demonstrated funnel

The persistent stage switcher provides five deterministic scenes:

1. **Review** — Leader plan proposal with revision, source, parallel work, review gate, and separate Adjust/Reject/Start actions.
2. **Execute** — Leader node’s embedded Dashboard summary. “Open execution” expands into the full Graph Inspector.
3. **Intervene** — Activity “Needs you” entry links to the exact Inspector node while unaffected branches remain visible.
4. **Complete** — Activity review distinguishes review-and-keep, review-and-remove, graph inspection, and later promotion.
5. **Recover** — a graph revision gap freezes controls, keeps last-known context visible, and refetches a full snapshot before restoring interaction.

Inside the Inspector, Flow, Plan map, and Context lineage retain a synchronized selection; plan and detail rails can collapse independently; plan focus, active/attention filters, checkpoint switching, pause/resume, and node inspection are interactive.

## Responsive evidence

- Desktop: persistent three-column workspace with independently collapsible rails.
- Compact desktop/tablet: narrower rails and hidden secondary metrics.
- Narrow `<900px`: both rails start as edge tabs and open as overlays.
- Small `<620px`: stacked proposal/lineage content, condensed mission header, scrollable controls, and a full-width stage switcher.
- Reduced-motion media query removes transitions and animation.

## Local validation

Validation completed on 2026-08-15:

- Inline JavaScript parsed successfully and `_d_meta.json` parsed as JSON.
- No external scripts, stylesheets, images, or font dependencies were found.
- A JSDOM interaction pass exercised all five stages at 1440px, 820px, and 390px with zero page/console errors.
- The wide-to-narrow transition automatically collapsed both rails; the intervention path resolved to M6’s exact decision wait.
- Duplicate-ID scan returned zero and `git diff --check` returned clean.

The managed execution sandbox denied local socket creation and Chromium crash-report sockets, so HTTP/browser launch could not run inside this task container. The artifact remains ready for an ordinary local browser check with:

Run from the repository root:

```sh
python3 -m http.server 4173 --directory designs
```

Then open `http://127.0.0.1:4173/dag-execution-workspace/` and click every numbered stage. The artifact has no external runtime, font, image, script, or stylesheet dependency.
