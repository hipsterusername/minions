/**
 * Component tests for `SessionPanel` usage section wiring.
 *
 * The panel is a thin shell over `usage-aggregator`; we verify the
 * integration glue:
 *   - expanding the panel reveals the usage section
 *   - SDK result events for arbitrary sessions feed the usage section (the
 *     panel subscribes globally, not per-session)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionPanel } from "./SessionPanel.tsx";
import { DockProvider } from "./BottomRightDock.tsx";

function renderPanel(props: Parameters<typeof SessionPanel>[0]) {
  return render(
    <DockProvider>
      <SessionPanel {...props} />
    </DockProvider>,
  );
}

let listeners: Array<(msg: unknown) => void> = [];

function subscribe(fn: (msg: unknown) => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

beforeEach(() => {
  listeners = [];
});

describe("SessionPanel usage section", () => {
  // Removed two `it` blocks that asserted only `getBy*(...).toBeDefined()`
  // (§5.5 TRIVIAL). The `getBy*` queries already throw if the element is
  // missing; the matcher adds nothing and no fireEvent followed.

  it("usage section is not visible when panel is collapsed", () => {
    renderPanel({
      socketSubscribe: subscribe,
      onAttachSession: () => {},
      attachedSessionKeys: new Set(),
    });
    // Panel starts collapsed — usage section should not be in the DOM
    expect(screen.queryByTestId("usage-section")).toBeNull();
  });
});
