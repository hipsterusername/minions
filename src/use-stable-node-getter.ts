import { useCallback, useRef } from "react";

/**
 * Build stable per-node getter closures.
 *
 * Returns a function `getFor(nodeId)` that yields a closure `() => T` whose
 * identity is stable across renders for a given `nodeId`, yet always calls the
 * latest `compute`. This lets memoized child nodes receive a prop that does not
 * change identity every render (avoiding needless re-renders) while still
 * reflecting up-to-date graph/context state through a ref indirection.
 */
export function useStableNodeGetter<T>(
  compute: (nodeId: string) => T,
): (nodeId: string) => () => T {
  const computeRef = useRef(compute);
  computeRef.current = compute;
  const cacheRef = useRef(new Map<string, () => T>());
  return useCallback((nodeId: string): (() => T) => {
    let getter = cacheRef.current.get(nodeId);
    if (!getter) {
      getter = () => computeRef.current(nodeId);
      cacheRef.current.set(nodeId, getter);
    }
    return getter;
  }, []);
}
