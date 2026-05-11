/**
 * list_harnesses — return the inventory of registered AgentHarnesses.
 *
 * Used by the client at startup so the session-creation UI can present a
 * harness selector and surface harness-aware model lists without a per-session
 * round-trip. Static metadata only — capabilities, models, commands, agents,
 * account — pulled from `harness.staticInfo()` plus the harness's declared
 * capabilities and built-in tools. No live-run state is consulted, so this
 * command is safe to call before any session exists.
 *
 * Phase E (Codex spec docs/codex-harness-spec.md): the smallest backend
 * surface needed to drive a harness picker.
 */

import { unicastGlobal } from "../bus.ts";
import { getHarness, registeredHarnessNames } from "../harness/index.ts";
import type { CommandHandler } from "./types.ts";

/**
 * Harnesses that are registered for tests / internal use but must not surface
 * in the client UI. The echo harness exists only as a zero-network test
 * fixture (see server/harness/echo/index.ts); exposing its single "echo"
 * model in the toolbar would mislead users into picking a placeholder.
 */
const HIDDEN_HARNESSES = new Set<string>(["echo"]);

export const listHarnesses: CommandHandler = (_ctx, _cmd, ws) => {
  const harnesses = registeredHarnessNames()
    .filter((name) => !HIDDEN_HARNESSES.has(name))
    .map((name) => {
      const h = getHarness(name);
      const info = h.staticInfo();
      return {
        name: h.name,
        capabilities: h.capabilities,
        builtInTools: h.builtInTools,
        models: info.models,
        commands: info.commands,
        agents: info.agents,
        account: info.account,
      };
    });
  unicastGlobal(ws, { type: "harness_list", harnesses });
};
