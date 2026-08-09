/**
 * `publish_html` — leader MCP tool for secure, visualization-only HTML.
 *
 * Companion to `server/render-tools.ts`. Kept in its own module so the core
 * render tools file stays within the 400-line server budget.
 *
 * Flow:
 *   1. The raw HTML is reduced to a strictly non-functional, visualization
 *      -only document by `sanitizeToSandboxDocument` (server/html-sanitize.ts).
 *      Scripts, event handlers, forms, external resource loads and navigation
 *      are stripped; a restrictive CSP `<meta>` is injected.
 *   2. The sanitized document is written to a session-scoped temp file
 *      (server/html-artifact-store.ts) so it can be cleaned up when the
 *      session is removed/cleared (and swept on startup if orphaned).
 *   3. An `html-artifact` component carrying the sanitized document is
 *      appended to the dashboard via the shared `appendComponents` callback,
 *      which the client renders inside an empty-`sandbox` iframe.
 *
 * Every path that can put an `html-artifact` on the wire is sanitized: this
 * tool sanitizes here, and `render-tools.ts` re-sanitizes any `html-artifact`
 * flowing through render_set/append/patch. `sanitizeToSandboxDocument` is
 * idempotent, so double-application is a no-op.
 */

import { z } from "zod/v4";
import type { NormalizedToolDef } from "./harness/types.ts";
import { textResult, errorResult } from "./harness/tool-result.ts";
import { sanitizeToSandboxDocument } from "./html-sanitize.ts";
import { writeHtmlArtifact } from "./html-artifact-store.ts";
import type { HtmlArtifactComponent, RenderComponent } from "../shared/render-dsl.ts";
import { serverLogger } from "./logging.ts";

const log = serverLogger.child("publish-html");

const publishHtmlInputSchema = z.object({
  html: z
    .string()
    .describe(
      "Raw HTML for a static visualization. It is sanitized on the server " +
        "(scripts, event handlers, forms, external loads and navigation are " +
        "removed) and rendered in a locked-down sandboxed iframe. " +
        "Visualization only — it cannot execute scripts or make network calls.",
    ),
  title: z
    .string()
    .optional()
    .describe("Optional heading shown above the artifact in the dashboard."),
  id: z
    .string()
    .optional()
    .describe(
      "Optional dashboard component id (for later render_patch/render_remove). " +
        "Auto-generated when omitted.",
    ),
  height: z
    .number()
    .optional()
    .describe("Preview height in px (default 240). The expand modal is larger."),
});

/**
 * Build the `publish_html` tool definition.
 *
 * @param opts.leaderSessionKey  session the artifact belongs to (cleanup key).
 * @param opts.appendComponents  shared render-append callback from
 *   `createRenderToolsForLeader` — emits the `render_update` envelope and
 *   updates persisted render state. Components handed to it are already
 *   sanitized here.
 */
export function createPublishHtmlToolDef(opts: {
  leaderSessionKey: string;
  appendComponents: (components: RenderComponent[]) => void;
}): NormalizedToolDef {
  const { leaderSessionKey, appendComponents } = opts;

  return {
    name: "publish_html",
    description:
      "Publish a static, NON-FUNCTIONAL HTML visualization to the dashboard. " +
      "The HTML is sanitized server-side and rendered inside a locked-down " +
      "sandboxed iframe (no scripts, no forms, no network, no navigation), " +
      "with a click-to-expand modal for a larger view. Use for rich visual " +
      "summaries (styled tables, diagrams, inline SVG charts) that the " +
      "structured DSL components cannot express. The temporary file is " +
      "cleaned up when the session is removed or cleared.",
    inputSchema: publishHtmlInputSchema,
    handler: async (input: unknown) => {
      const args = publishHtmlInputSchema.parse(input);

      // 1. Sanitize to a self-contained, CSP-wrapped, script-free document.
      const safeDoc = sanitizeToSandboxDocument(args.html);

      // 2. Persist the sanitized document to a session-scoped temp file.
      let artifactId: string | undefined;
      let filePath: string | undefined;
      let bytes = Buffer.byteLength(safeDoc, "utf8");
      try {
        const meta = await writeHtmlArtifact(leaderSessionKey, {
          html: safeDoc,
          ...(args.title !== undefined ? { title: args.title } : {}),
        });
        artifactId = meta.id;
        filePath = meta.path;
        bytes = meta.bytes;
      } catch (err) {
        // A temp-file failure must not block the dashboard visualization —
        // the sanitized content is delivered inline via the component below.
        log.warn("artifact_write_failed", { leaderSessionKey, error: err });
      }

      // 3. Append the sanitized artifact to the dashboard.
      const componentId = args.id ?? `html-${artifactId ?? "artifact"}`;
      const component: HtmlArtifactComponent = {
        id: componentId,
        type: "html-artifact",
        html: safeDoc,
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.height !== undefined ? { height: args.height } : {}),
        ...(artifactId !== undefined ? { artifactId } : {}),
      };

      try {
        appendComponents([component]);
      } catch (err) {
        return errorResult(
          `Failed to render HTML artifact: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      const where = filePath ? ` Temp file: ${filePath}.` : "";
      return textResult(
        `Published sanitized HTML artifact as component "${componentId}" ` +
          `(${bytes} bytes). Rendered in a locked-down sandboxed iframe with ` +
          `click-to-expand.${where}`,
      );
    },
  };
}
