// Every generation gets both listeners. Only explicit restart requests may
// replace a generation, after the caller has completed its owned cleanup.
export function supervise(launch, { stopped, reconcile, fail }) {
  let child;
  function next() {
    if (stopped()) return;
    try { child = launch(); } catch (error) { fail(error); return; }
    const generation = child;
    let handled = false;
    const finish = async (code, error, signal) => {
      if (handled) return;
      handled = true;
      if (stopped()) return;
      try {
        if (!error && code === 42 && await reconcile(generation)) { next(); return; }
        fail(error ?? new Error(`Backend exited (${signal ?? code}); recovery refused: automatic crash replay is disabled or restart cleanup is unavailable`));
      } catch (failure) { fail(failure); }
    };
    child.once("error", (error) => void finish(null, error));
    child.once("exit", (code, signal) => void finish(code, undefined, signal));
  }
  next();
  return { get child() { return child; } };
}
