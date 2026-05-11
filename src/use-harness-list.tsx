/**
 * Harness inventory provider + hook.
 *
 * One owner per project view fetches `list_harnesses` once on connect and
 * caches the result. Components consume it via `useHarnessList()` and look
 * up by name with `findHarness(harnesses, name)`.
 *
 * Phase E — replaces hard-coded Claude-only model lists in `SessionToolbar`
 * and `model-meta` so harness-specific models surface only when their
 * harness is in use. See docs/codex-harness-spec.md §5.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { HarnessInfo } from "./harness-list.ts";
import type { HarnessListEntry } from "./use-socket.ts";

interface HarnessListValue {
  harnesses: ReadonlyArray<HarnessInfo>;
  /** True once the server has answered at least one `list_harnesses` request. */
  loaded: boolean;
}

const EMPTY_VALUE: HarnessListValue = { harnesses: [], loaded: false };

const HarnessListContext = createContext<HarnessListValue>(EMPTY_VALUE);

/** Read the current harness inventory. Returns an empty array until loaded. */
export function useHarnessList(): HarnessListValue {
  return useContext(HarnessListContext);
}

interface ProviderProps {
  children: ReactNode;
  /** Send a WS command. */
  send: (data: unknown) => void;
  /** Subscribe to server messages. */
  subscribe: (fn: (msg: unknown) => void) => () => void;
  /** True when the WebSocket is open. */
  connected: boolean;
}

/**
 * Provider that issues `list_harnesses` once on connect and caches the
 * result for descendants. Re-issues on reconnect so a server with a
 * different registered set is picked up.
 */
export function HarnessListProvider({
  children,
  send,
  subscribe,
  connected,
}: ProviderProps): React.ReactElement {
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!connected) return;
    send({ type: "list_harnesses" });
  }, [connected, send]);

  useEffect(() => {
    return subscribe((msg) => {
      const m = msg as { type?: string; harnesses?: HarnessListEntry[] };
      if (m.type !== "harness_list" || !Array.isArray(m.harnesses)) return;
      setHarnesses(m.harnesses.map(toHarnessInfo));
      setLoaded(true);
    });
  }, [subscribe]);

  const value = useMemo<HarnessListValue>(
    () => ({ harnesses, loaded }),
    [harnesses, loaded],
  );

  return (
    <HarnessListContext.Provider value={value}>
      {children}
    </HarnessListContext.Provider>
  );
}

function toHarnessInfo(entry: HarnessListEntry): HarnessInfo {
  return {
    name: entry.name,
    capabilities: entry.capabilities,
    builtInTools: entry.builtInTools,
    models: entry.models,
    commands: entry.commands,
    agents: entry.agents,
    account: entry.account,
  };
}
