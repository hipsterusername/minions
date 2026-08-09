/**
 * list_harnesses — return the inventory of registered AgentHarnesses.
 *
 * Used by the client at startup so the session-creation UI can present a
 * harness selector and surface harness-aware model lists without a per-session
 * round-trip. Static metadata only — capabilities, models, commands, agents,
 * account — pulled from `harness.staticInfo()` plus the harness's declared
 * capabilities and built-in tools. No live-run state is consulted, so this
 * command is safe to call before any session exists.
 */

import { unicastGlobal } from "../bus.ts";
import { productionHarnesses } from "../harness/index.ts";
import { getHarnessReadiness } from "../harness/readiness.ts";
import type { CommandHandler } from "./types.ts";

/**
 * Harnesses that are registered for tests / internal use but must not surface
 * in the client UI. The echo harness exists only as a zero-network test
 * fixture (see server/harness/echo/index.ts); exposing its single "echo"
 * model in the toolbar would mislead users into picking a placeholder.
 */
export const listHarnesses: CommandHandler = async (_ctx, _cmd, ws) => {
  const snapshot = await getHarnessReadiness();
  const harnesses = productionHarnesses()
    .map((h) => {
      const info = h.staticInfo();
      return {
        name: h.name,
        capabilities: h.capabilities,
        builtInTools: h.builtInTools,
        models: info.models,
        commands: info.commands,
        agents: info.agents,
        account: info.account,
        readiness: snapshot.harnesses.find((item) => item.name === h.name),
      };
    });
  unicastGlobal(ws, { type: "harness_list", harnesses });
};
